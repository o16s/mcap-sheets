import { BlobReadable } from '@mcap/browser';
import {
  McapIndexedReader,
  McapStreamReader,
  type DecompressHandlers,
  type TypedMcapRecord,
} from '@mcap/core';
import lz4js from 'lz4js';
import { decompress as decompressZstd } from 'fzstd';
import {
  flattenJsonPayload,
  LOG_TIME_COLUMN,
  normalizeTopicAccumulator,
  PUBLISH_TIME_COLUMN,
  type CellValue,
  type TopicAccumulator,
} from './worksheet';
import {
  CachingReadable,
  MIN_RANGE_BYTES,
  probeRangeSupport,
  RangeReadable,
} from './rangeReadable';

const textDecoder = new TextDecoder();

// Decompressors for lz4/zstd-compressed MCAP chunks. Without these, files
// written with compression fail to read. We use pure-JS decoders (lz4js /
// fzstd) rather than the WASM-backed @foxglove decompressors so the library
// stays a drop-in dependency: no .wasm assets to bundle and no bundler-specific
// wasm configuration for consumers. bz2 is intentionally unsupported — MCAP
// writers effectively never use it.
const decompressHandlers: DecompressHandlers = {
  lz4: (buffer) => new Uint8Array(lz4js.decompress(buffer)),
  zstd: (buffer) => decompressZstd(buffer),
};

// Cache message-index regions read on demand so re-querying different channels
// within a chunk doesn't re-read them from the network.
const MESSAGE_INDEX_CACHE_BYTES = 50 * 1024 * 1024;
// Cap for the range-request byte cache, so browsing many topics of a large
// file doesn't re-fetch shared chunks but also can't grow without bound.
const RANGE_CACHE_BYTES = 256 * 1024 * 1024;
// Above this many chunks, per-chunk range requests become a serial round-trip
// bottleneck — a single whole-file download is dramatically faster.
const COALESCE_MIN_CHUNKS = 16;
// Upper bound for pulling a whole file into memory (coalesced read / recovery).
const WHOLE_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;
// Bytes fed to the stream reader per slice during recovery, between UI yields.
const RECOVER_SLICE_BYTES = 4 * 1024 * 1024;

export type ProgressPhase = 'downloading' | 'recovering';
export interface LoadProgress {
  phase: ProgressPhase;
  fraction: number;
}
export type ProgressCallback = (progress: LoadProgress) => void;
export interface OpenMcapOptions {
  onProgress?: ProgressCallback;
}

export interface TopicWorksheet {
  topic: string;
  columns: string[];
  rows: Array<Record<string, CellValue>>;
}

export interface TopicSummary {
  topic: string;
  /** Message count from the file's Statistics record, when present. */
  messageCount?: number;
}

/**
 * A lazily-loaded MCAP workbook: the topic list (and counts) are known up
 * front from the summary section, and each topic's rows are read on demand.
 */
export interface McapWorkbookSource {
  topics: TopicSummary[];
  /** Whether reads are served via HTTP range requests rather than a full download. */
  ranged: boolean;
  /** Whether the whole file was downloaded once instead of per-chunk range reads. */
  coalesced?: boolean;
  /** Whether the file was recovered by streaming (truncated/unindexed). */
  recovered?: boolean;
  loadTopic: (topic: string) => Promise<TopicWorksheet>;
}

const decodePayload = (data: Uint8Array, shouldParseJson: boolean): unknown => {
  if (shouldParseJson) {
    const decoded = textDecoder.decode(data);

    try {
      return JSON.parse(decoded);
    } catch {
      return decoded;
    }
  }

  return btoa(String.fromCharCode(...data));
};

// --- Shared row building (used by indexed, coalesced, and recovery paths) ---

const shouldParseJson = (
  channel: { messageEncoding: string },
  schema: { encoding?: string } | undefined,
): boolean =>
  channel.messageEncoding.includes('json') || schema?.encoding?.includes('json') || false;

const messageToRow = (
  message: { data: Uint8Array; logTime: bigint; publishTime: bigint },
  channel: { messageEncoding: string },
  schema: { encoding?: string } | undefined,
): Record<string, CellValue> => {
  const decoded = decodePayload(message.data, shouldParseJson(channel, schema));
  const flattened = flattenJsonPayload(decoded);
  // Inject the message timestamps after the payload so they remain the
  // authoritative record time even if a payload field shares the name.
  return {
    ...flattened,
    [LOG_TIME_COLUMN]: message.logTime.toString(),
    [PUBLISH_TIME_COLUMN]: message.publishTime.toString(),
  };
};

const newAccumulator = (): TopicAccumulator => ({
  columns: new Set<string>([LOG_TIME_COLUMN, PUBLISH_TIME_COLUMN]),
  rows: [],
});

const pushRow = (
  accumulators: Map<string, TopicAccumulator>,
  topic: string,
  row: Record<string, CellValue>,
): void => {
  let accumulator = accumulators.get(topic);
  if (!accumulator) {
    accumulator = newAccumulator();
    accumulators.set(topic, accumulator);
  }
  for (const column of Object.keys(row)) {
    accumulator.columns.add(column);
  }
  accumulator.rows.push(row);
};

const worksheetsFromAccumulators = (
  accumulators: Map<string, TopicAccumulator>,
): TopicWorksheet[] =>
  Array.from(accumulators.entries())
    .map(([topic, accumulator]) => {
      const normalized = normalizeTopicAccumulator(accumulator);
      return { topic, columns: normalized.columns, rows: normalized.rows };
    })
    .sort((left, right) => left.topic.localeCompare(right.topic));

// Wraps eagerly-built worksheets in a lazy-shaped source (used by the coalesced
// blob path indirectly and by recovery).
const sourceFromWorksheets = (
  worksheets: TopicWorksheet[],
  extra: Partial<McapWorkbookSource>,
): McapWorkbookSource => {
  const byTopic = new Map(worksheets.map((sheet) => [sheet.topic, sheet]));
  return {
    topics: worksheets.map((sheet) => ({ topic: sheet.topic, messageCount: sheet.rows.length })),
    ranged: false,
    loadTopic: async (topic) => byTopic.get(topic) ?? { topic, columns: [], rows: [] },
    ...extra,
  };
};

// --- Downloading ---

/**
 * Downloads the whole file into memory, streaming the body so download progress
 * can be reported. Falls back to a single buffered read if the body isn't a
 * readable stream or Content-Length is missing.
 */
const downloadFull = async (
  url: string,
  onProgress?: ProgressCallback,
  phase: ProgressPhase = 'downloading',
): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch MCAP file (${response.status})`);
  }

  const total = Number(response.headers.get('Content-Length') ?? 0);
  const body = response.body;
  if (!body || !total) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    onProgress?.({ phase, fraction: 1 });
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    received += value.length;
    onProgress?.({ phase, fraction: Math.min(1, received / total) });
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

// --- Indexed reading ---

const buildReadable = async (
  url: string,
): Promise<{ readable: RangeReadable | CachingReadable | BlobReadable; ranged: boolean; sizeBytes: number }> => {
  const probe = await probeRangeSupport(url);

  if (probe.supported && probe.size !== undefined && probe.size >= BigInt(MIN_RANGE_BYTES)) {
    const ranged = new CachingReadable(new RangeReadable(url, probe.size), RANGE_CACHE_BYTES);
    return { readable: ranged, ranged: true, sizeBytes: Number(probe.size) };
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch MCAP file (${response.status})`);
  }
  const blob = await response.blob();
  return { readable: new BlobReadable(blob), ranged: false, sizeBytes: blob.size };
};

const createReader = async (url: string) => {
  const { readable, ranged, sizeBytes } = await buildReadable(url);
  const reader = await McapIndexedReader.Initialize({
    readable,
    decompressHandlers,
    messageIndexCacheSizeBytes: MESSAGE_INDEX_CACHE_BYTES,
  });
  return { reader, ranged, sizeBytes };
};

type IndexedReader = Awaited<ReturnType<typeof McapIndexedReader.Initialize>>;

const buildTopicSummaries = (reader: IndexedReader): TopicSummary[] => {
  const counts = reader.statistics?.channelMessageCounts;
  const totals = new Map<string, number | undefined>();

  for (const [channelId, channel] of reader.channelsById) {
    const count = counts?.get(channelId);
    const existing = totals.get(channel.topic);
    if (count === undefined) {
      if (!totals.has(channel.topic)) {
        totals.set(channel.topic, undefined);
      }
    } else {
      totals.set(channel.topic, (existing ?? 0) + Number(count));
    }
  }

  return Array.from(totals.entries())
    .map(([topic, messageCount]) => ({ topic, messageCount }))
    .sort((left, right) => left.topic.localeCompare(right.topic));
};

const readTopicWorksheet = async (
  reader: IndexedReader,
  topic: string,
): Promise<TopicWorksheet> => {
  const accumulator = newAccumulator();

  for await (const message of reader.readMessages({ topics: [topic] })) {
    const channel = reader.channelsById.get(message.channelId);
    if (!channel) {
      continue;
    }
    const schema = reader.schemasById.get(channel.schemaId);
    const row = messageToRow(message, channel, schema);
    for (const column of Object.keys(row)) {
      accumulator.columns.add(column);
    }
    accumulator.rows.push(row);
  }

  const normalized = normalizeTopicAccumulator(accumulator);
  return { topic, columns: normalized.columns, rows: normalized.rows };
};

const sourceFromReader = (reader: IndexedReader, ranged: boolean): McapWorkbookSource => ({
  topics: buildTopicSummaries(reader),
  ranged,
  loadTopic: (topic: string) => readTopicWorksheet(reader, topic),
});

// --- Coalescing (many small chunks → one whole-file download) ---

/** Whether per-chunk range reads would be too chatty and a whole download wins. */
export const isChunkDense = (chunkCount: number, sizeBytes: number): boolean =>
  chunkCount > COALESCE_MIN_CHUNKS && sizeBytes <= WHOLE_DOWNLOAD_MAX_BYTES;

// Keeps the (already-read) summary for the instant topic list, but reads message
// data from a single lazily-downloaded whole-file blob instead of hundreds of
// per-chunk range requests.
const coalescedSource = (
  url: string,
  summaryReader: IndexedReader,
  onProgress?: ProgressCallback,
): McapWorkbookSource => {
  let blobReaderPromise: Promise<IndexedReader> | undefined;
  const getReader = () => {
    blobReaderPromise ??= downloadFull(url, onProgress, 'downloading').then((bytes) =>
      McapIndexedReader.Initialize({
        readable: new BlobReadable(new Blob([bytes as BlobPart])),
        decompressHandlers,
        messageIndexCacheSizeBytes: MESSAGE_INDEX_CACHE_BYTES,
      }),
    );
    return blobReaderPromise;
  };

  return {
    topics: buildTopicSummaries(summaryReader),
    ranged: false,
    coalesced: true,
    loadTopic: async (topic) => readTopicWorksheet(await getReader(), topic),
  };
};

// --- Recovery (truncated / unindexed files, via streaming) ---

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type SchemaRecord = Extract<TypedMcapRecord, { type: 'Schema' }>;
type ChannelRecord = Extract<TypedMcapRecord, { type: 'Channel' }>;

/**
 * Recovers readable records from a (possibly truncated) MCAP buffer by streaming
 * from the start — no footer/index required. Keeps every complete record up to
 * the truncation point; the incomplete tail is dropped. Exported for tests.
 */
export const recoverFromBytes = async (
  bytes: Uint8Array,
  options: OpenMcapOptions = {},
): Promise<TopicWorksheet[]> => {
  const reader = new McapStreamReader({ decompressHandlers, validateCrcs: false });
  const schemas = new Map<number, SchemaRecord>();
  const channels = new Map<number, ChannelRecord>();
  const accumulators = new Map<string, TopicAccumulator>();
  const total = bytes.length;

  for (let offset = 0; offset < total; ) {
    const end = Math.min(offset + RECOVER_SLICE_BYTES, total);
    reader.append(bytes.subarray(offset, end));
    offset = end;

    try {
      let record: TypedMcapRecord | undefined;
      while ((record = reader.nextRecord())) {
        if (record.type === 'Schema') {
          schemas.set(record.id, record);
        } else if (record.type === 'Channel') {
          channels.set(record.id, record);
        } else if (record.type === 'Message') {
          const channel = channels.get(record.channelId);
          if (!channel) {
            continue;
          }
          pushRow(accumulators, channel.topic, messageToRow(record, channel, schemas.get(channel.schemaId)));
        }
      }
    } catch {
      // A parse error here is the truncated tail — keep what we have.
      break;
    }

    options.onProgress?.({ phase: 'recovering', fraction: total ? offset / total : 1 });
    await yieldToUi();
  }

  return worksheetsFromAccumulators(accumulators);
};

const recoverWorkbook = async (
  url: string,
  onProgress?: ProgressCallback,
): Promise<McapWorkbookSource> => {
  const bytes = await downloadFull(url, onProgress, 'downloading');
  const worksheets = await recoverFromBytes(bytes, { onProgress });
  return sourceFromWorksheets(worksheets, { recovered: true });
};

// --- Public entry points ---

/**
 * Opens an MCAP file for lazy reading. Reads only the summary section up front
 * (leveraging HTTP range requests when the server supports them) to list topics;
 * each topic's rows are decoded on demand. Falls back to a single whole-file
 * download for chunk-dense files (where per-chunk range reads would be slow),
 * and to a streaming recovery for truncated/unindexed files.
 */
export const openMcapWorkbook = async (
  url: string,
  options: OpenMcapOptions = {},
): Promise<McapWorkbookSource> => {
  let created: Awaited<ReturnType<typeof createReader>>;
  try {
    created = await createReader(url);
  } catch (indexedError) {
    try {
      return await recoverWorkbook(url, options.onProgress);
    } catch {
      throw indexedError;
    }
  }

  const { reader, ranged, sizeBytes } = created;
  if (ranged && isChunkDense(reader.chunkIndexes.length, sizeBytes)) {
    return coalescedSource(url, reader, options.onProgress);
  }
  return sourceFromReader(reader, ranged);
};

/**
 * Opens an MCAP file from a local `Blob`/`File` (e.g. a file picker), reading it
 * entirely in the browser with no upload or server round-trip. Falls back to
 * streaming recovery for truncated/unindexed local files.
 */
export const openMcapWorkbookFromBlob = async (
  blob: Blob,
  options: OpenMcapOptions = {},
): Promise<McapWorkbookSource> => {
  try {
    const reader = await McapIndexedReader.Initialize({
      readable: new BlobReadable(blob),
      decompressHandlers,
      messageIndexCacheSizeBytes: MESSAGE_INDEX_CACHE_BYTES,
    });
    return sourceFromReader(reader, false);
  } catch (indexedError) {
    try {
      const worksheets = await recoverFromBytes(new Uint8Array(await blob.arrayBuffer()), options);
      return sourceFromWorksheets(worksheets, { recovered: true });
    } catch {
      throw indexedError;
    }
  }
};
