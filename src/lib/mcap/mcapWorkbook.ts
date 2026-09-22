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
  orderColumns,
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
import { streamDecode, type DecodeBatch } from './decodeCore';
import type { DecodeRequest, DecodeResponse } from './decode.worker';

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
// A file is "chunk-dense" — better read by one sequential pass than per-chunk
// random access — when it has many chunks AND those chunks are small. Small
// chunks mean each per-chunk round-trip carries almost no payload, so loading a
// topic (which touches nearly every chunk) becomes thousands of latency-bound
// round-trips. Large chunks amortize the round-trip, so those files keep the
// lazy range path even when there are many of them.
const COALESCE_MIN_CHUNKS = 16;
const DENSE_CHUNK_MAX_BYTES = 1024 * 1024;
// Bytes consumed between UI yields / progress updates during a streaming pass.
const RECOVER_SLICE_BYTES = 4 * 1024 * 1024;
// Bytes between progressive snapshots after the first. Coarser than the yield
// cadence so the UI paints the first rows immediately, then grows a handful of
// times, rather than rebuilding the table on every 4 MB.
const PARTIAL_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export type ProgressPhase = 'downloading' | 'recovering';
export interface LoadProgress {
  phase: ProgressPhase;
  fraction: number;
}
export type ProgressCallback = (progress: LoadProgress) => void;
export interface OpenMcapOptions {
  onProgress?: ProgressCallback;
}

/**
 * A decoded topic in column-major form. `columnData.get(col)[rowIndex]` is a
 * cell (missing cells are holes → read as null via `cellAt`); `rowCount` is the
 * row total. Storing columns rather than per-row objects keeps wide schemas
 * (hundreds of columns × 100k+ rows) from exploding the heap.
 */
export interface TopicWorksheet {
  topic: string;
  columns: string[];
  rowCount: number;
  columnData: Map<string, CellValue[]>;
}

/** Reads a cell, treating out-of-range/omitted cells as null. */
export const cellAt = (sheet: TopicWorksheet, rowIndex: number, column: string): CellValue =>
  sheet.columnData.get(column)?.[rowIndex] ?? null;

/**
 * The eager, row-shaped input accepted by the component's `dataLoader` override
 * (tests/stories/embedders feeding their own small datasets). Converted to a
 * columnar `TopicWorksheet` via `worksheetFromRows`.
 */
export interface TopicRows {
  topic: string;
  columns: string[];
  rows: Array<Record<string, CellValue>>;
}

/**
 * A read-only, memory-safe view of a topic's rows handed to `onRowsLoaded`, so
 * an embedder can map cell values (e.g. a timestamp) to a row index without the
 * component ever materializing 100k row objects.
 */
export interface TopicRowsView {
  topic: string;
  rowCount: number;
  columns: readonly string[];
  /** A single cell by unfiltered row index (null for empty/out-of-range). */
  cell: (rowIndex: number, column: string) => CellValue;
  /** A whole column, column-major, or undefined if the column is absent. */
  column: (name: string) => readonly CellValue[] | undefined;
}

/** Builds a columnar worksheet from eager row objects, preserving column order. */
export const worksheetFromRows = ({ topic, columns, rows }: TopicRows): TopicWorksheet => {
  const columnData = new Map<string, CellValue[]>();
  for (const column of columns) {
    columnData.set(column, []);
  }
  rows.forEach((row, rowIndex) => {
    for (const column of columns) {
      columnData.get(column)![rowIndex] = row[column] ?? null;
    }
  });
  return { topic, columns: [...columns], rowCount: rows.length, columnData };
};

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
  /**
   * Loads a topic's rows. `onPartial` (when supported by the source — the
   * streaming path) fires with growing snapshots as rows decode, so the UI can
   * paint progressively; the returned promise resolves with the final sheet.
   * Snapshots share the underlying column arrays with the final sheet.
   */
  loadTopic: (
    topic: string,
    onPartial?: (sheet: TopicWorksheet) => void,
  ) => Promise<TopicWorksheet>;
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
  columnData: new Map<string, CellValue[]>(),
  rowCount: 0,
});

// Appends one row's cells into the column-major store; omitted columns stay holes.
const addRow = (accumulator: TopicAccumulator, row: Record<string, CellValue>): void => {
  const rowIndex = accumulator.rowCount;
  for (const column of Object.keys(row)) {
    accumulator.columns.add(column);
    let cells = accumulator.columnData.get(column);
    if (!cells) {
      cells = [];
      accumulator.columnData.set(column, cells);
    }
    cells[rowIndex] = row[column];
  }
  accumulator.rowCount += 1;
};

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
  addRow(accumulator, row);
};

const worksheetFromAccumulator = (topic: string, accumulator: TopicAccumulator): TopicWorksheet => {
  const normalized = normalizeTopicAccumulator(accumulator);
  return {
    topic,
    columns: normalized.columns,
    rowCount: normalized.rowCount,
    columnData: normalized.columnData,
  };
};

const worksheetsFromAccumulators = (
  accumulators: Map<string, TopicAccumulator>,
): TopicWorksheet[] =>
  Array.from(accumulators.entries())
    .map(([topic, accumulator]) => worksheetFromAccumulator(topic, accumulator))
    .sort((left, right) => left.topic.localeCompare(right.topic));

// Wraps eagerly-built worksheets in a lazy-shaped source (used by the coalesced
// blob path indirectly and by recovery).
const sourceFromWorksheets = (
  worksheets: TopicWorksheet[],
  extra: Partial<McapWorkbookSource>,
): McapWorkbookSource => {
  const byTopic = new Map(worksheets.map((sheet) => [sheet.topic, sheet]));
  return {
    topics: worksheets.map((sheet) => ({ topic: sheet.topic, messageCount: sheet.rowCount })),
    ranged: false,
    loadTopic: async (topic) =>
      byTopic.get(topic) ?? { topic, columns: [], rowCount: 0, columnData: new Map() },
    ...extra,
  };
};

// --- Sequential streaming (chunk-dense files + recovery) ---

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type SchemaRecord = Extract<TypedMcapRecord, { type: 'Schema' }>;
type ChannelRecord = Extract<TypedMcapRecord, { type: 'Channel' }>;

// Feeds an in-memory buffer to the stream reader in fixed windows (recovery from
// an already-downloaded Uint8Array).
async function* slicesFromBytes(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += RECOVER_SLICE_BYTES) {
    yield bytes.subarray(offset, Math.min(offset + RECOVER_SLICE_BYTES, bytes.length));
  }
}

// Reads a local Blob/File sequentially in windows, so we never hold the whole
// file in memory at once.
async function* slicesFromBlob(blob: Blob): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < blob.size; offset += RECOVER_SLICE_BYTES) {
    const end = Math.min(offset + RECOVER_SLICE_BYTES, blob.size);
    yield new Uint8Array(await blob.slice(offset, end).arrayBuffer());
  }
}

async function* slicesFromStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    yield value;
  }
}

// One HTTP GET, consumed sequentially. Prefers the response body stream (bounded
// memory); falls back to a single buffered read when streaming isn't available.
const fetchSlices = async (
  url: string,
): Promise<{ slices: AsyncGenerator<Uint8Array>; total: number }> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch MCAP file (${response.status})`);
  }
  const total = Number(response.headers.get('Content-Length') ?? 0);
  if (response.body) {
    return { slices: slicesFromStream(response.body), total };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { slices: slicesFromBytes(bytes), total: bytes.length };
};

/**
 * Decodes an MCAP file by streaming it front-to-back through `McapStreamReader`
 * — no footer/index needed and no per-chunk seeking. Holds only one chunk's
 * worth of bytes at a time (plus the accumulated rows), so it scales to files of
 * any size. Keeps every complete record up to the first parse error, which for a
 * truncated file is the incomplete tail. Progress/UI yields are throttled to
 * ~`RECOVER_SLICE_BYTES` so a stream of tiny network chunks doesn't thrash.
 *
 * When `topic` is given, only that topic's rows are accumulated (the pass still
 * decompresses every chunk, but bounds memory to the one topic being read).
 */
const streamWorksheets = async (
  slices: AsyncIterable<Uint8Array>,
  {
    total,
    phase,
    onProgress,
    topic,
    onPartial,
  }: {
    total: number;
    phase: ProgressPhase;
    onProgress?: ProgressCallback;
    topic?: string;
    /** Emits growing snapshots as rows decode, so the UI can paint progressively. */
    onPartial?: (worksheets: TopicWorksheet[]) => void;
  },
): Promise<TopicWorksheet[]> => {
  const reader = new McapStreamReader({ decompressHandlers, validateCrcs: false });
  const schemas = new Map<number, SchemaRecord>();
  const channels = new Map<number, ChannelRecord>();
  const accumulators = new Map<string, TopicAccumulator>();
  let consumed = 0;
  let reported = 0;
  let rows = 0;
  let lastPartial = 0;
  let emittedPartial = false;
  const report = () =>
    onProgress?.({ phase, fraction: total ? Math.min(1, consumed / total) : 1 });

  for await (const slice of slices) {
    reader.append(slice);
    consumed += slice.length;

    let truncated = false;
    try {
      let record: TypedMcapRecord | undefined;
      while ((record = reader.nextRecord())) {
        if (record.type === 'Schema') {
          schemas.set(record.id, record);
        } else if (record.type === 'Channel') {
          channels.set(record.id, record);
        } else if (record.type === 'Message') {
          const channel = channels.get(record.channelId);
          if (channel && (topic === undefined || channel.topic === topic)) {
            pushRow(
              accumulators,
              channel.topic,
              messageToRow(record, channel, schemas.get(channel.schemaId)),
            );
            rows += 1;
          }
        }
      }
    } catch {
      // A parse error means an incomplete/truncated tail — keep what we have.
      truncated = true;
    }

    if (truncated) {
      break;
    }

    let didWork = false;
    // Throttle progress so many tiny network chunks don't thrash.
    if (consumed - reported >= RECOVER_SLICE_BYTES) {
      reported = consumed;
      report();
      didWork = true;
    }
    // Emit the first snapshot as soon as any rows exist (instant first paint),
    // then coarsely thereafter. Snapshots share the growing column arrays.
    if (
      onPartial &&
      rows > 0 &&
      (!emittedPartial || consumed - lastPartial >= PARTIAL_SNAPSHOT_BYTES)
    ) {
      emittedPartial = true;
      lastPartial = consumed;
      onPartial(worksheetsFromAccumulators(accumulators));
      didWork = true;
    }
    // Yield to let the browser paint whatever we just surfaced.
    if (didWork) {
      await yieldToUi();
    }
  }

  report();
  return worksheetsFromAccumulators(accumulators);
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
  const { readable, ranged } = await buildReadable(url);
  const reader = await McapIndexedReader.Initialize({
    readable,
    decompressHandlers,
    messageIndexCacheSizeBytes: MESSAGE_INDEX_CACHE_BYTES,
  });
  return { reader, ranged };
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
    addRow(accumulator, messageToRow(message, channel, schema));
  }

  return worksheetFromAccumulator(topic, accumulator);
};

const sourceFromReader = (reader: IndexedReader, ranged: boolean): McapWorkbookSource => ({
  topics: buildTopicSummaries(reader),
  ranged,
  loadTopic: (topic: string) => readTopicWorksheet(reader, topic),
});

// --- Coalescing (many small chunks → one sequential streaming pass) ---

/**
 * Whether per-chunk random-access reads would be too chatty and a single
 * sequential streaming pass wins. True for many small chunks (round-trip bound);
 * false for few chunks, or many *large* chunks that amortize each round-trip and
 * are served better by lazily reading only the requested topic. Independent of
 * total file size — the streaming pass is memory-bounded, so it scales to files
 * far larger than memory. Exported for tests.
 */
export const isChunkDense = (chunkCount: number, averageChunkBytes: number): boolean =>
  chunkCount > COALESCE_MIN_CHUNKS && averageChunkBytes < DENSE_CHUNK_MAX_BYTES;

// Average on-disk size of the file's chunk records — the density signal.
const averageChunkBytes = (reader: IndexedReader): number => {
  const chunks = reader.chunkIndexes;
  if (chunks.length === 0) {
    return Infinity;
  }
  let total = 0;
  for (const chunk of chunks) {
    total += Number(chunk.chunkLength);
  }
  return total / chunks.length;
};

// Assembles column-major batches (from the worker or the main-thread fallback)
// into a growing columnar worksheet, sharing its arrays across snapshots.
class ColumnarBuilder {
  private readonly columns = new Set<string>([LOG_TIME_COLUMN, PUBLISH_TIME_COLUMN]);
  private readonly columnData = new Map<string, CellValue[]>();
  private rowCount = 0;

  apply(batch: DecodeBatch): void {
    for (const [column, values] of batch.data) {
      this.columns.add(column);
      let cells = this.columnData.get(column);
      if (!cells) {
        cells = [];
        this.columnData.set(column, cells);
      }
      for (let i = 0; i < batch.count; i += 1) {
        const value = values[i];
        if (value !== undefined) {
          cells[batch.start + i] = value;
        }
      }
    }
    this.rowCount = Math.max(this.rowCount, batch.start + batch.count);
  }

  snapshot(topic: string): TopicWorksheet {
    return {
      topic,
      columns: orderColumns(this.columns),
      rowCount: this.rowCount,
      columnData: this.columnData,
    };
  }
}

const spec = (url: string, blob: Blob | undefined, topic: string): DecodeRequest =>
  blob ? { kind: 'blob', blob, topic } : { kind: 'url', url, topic };

// Decodes a topic in a Web Worker, applying column batches to a builder on the
// main thread (which only appends + snapshots — no decode, no jank).
const decodeInWorker = (
  request: DecodeRequest,
  onPartial: ((sheet: TopicWorksheet) => void) | undefined,
  onProgress: ProgressCallback | undefined,
  worker: Worker,
): Promise<TopicWorksheet> =>
  new Promise<TopicWorksheet>((resolve, reject) => {
    const builder = new ColumnarBuilder();
    worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
      const message = event.data;
      if (message.type === 'batch') {
        builder.apply(message.batch);
        onPartial?.(builder.snapshot(request.topic));
      } else if (message.type === 'progress') {
        onProgress?.({ phase: 'downloading', fraction: message.fraction });
      } else if (message.type === 'done') {
        worker.terminate();
        resolve(builder.snapshot(request.topic));
      } else {
        worker.terminate();
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error instanceof Error ? event.error : new Error('MCAP decode worker failed'));
    };
    worker.postMessage(request);
  });

// Fallback when Web Workers are unavailable: same streaming decode on the main
// thread (yields between slices to stay responsive, but not jank-free).
const decodeOnMainThread = async (
  request: DecodeRequest,
  onPartial: ((sheet: TopicWorksheet) => void) | undefined,
  onProgress: ProgressCallback | undefined,
): Promise<TopicWorksheet> => {
  const { slices, total } =
    request.kind === 'url'
      ? await fetchSlices(request.url)
      : { slices: slicesFromBlob(request.blob), total: request.blob.size };
  const builder = new ColumnarBuilder();
  await streamDecode(slices, {
    topic: request.topic,
    total,
    onBatch: (batch) => {
      builder.apply(batch);
      onPartial?.(builder.snapshot(request.topic));
    },
    onProgress: (fraction) => onProgress?.({ phase: 'downloading', fraction }),
  });
  return builder.snapshot(request.topic);
};

const decodeTopic = async (
  request: DecodeRequest,
  onPartial: ((sheet: TopicWorksheet) => void) | undefined,
  onProgress: ProgressCallback | undefined,
): Promise<TopicWorksheet> => {
  if (typeof Worker !== 'undefined') {
    try {
      const { createDecodeWorker } = await import('./workerFactory');
      return await decodeInWorker(request, onPartial, onProgress, createDecodeWorker());
    } catch {
      // Bundler/runtime without inline-worker support → fall back.
    }
  }
  return decodeOnMainThread(request, onPartial, onProgress);
};

// Keeps the (already-read) summary for the instant topic list, but decodes each
// topic's rows in a Web Worker (off the main thread) via a single sequential
// pass — instant first paint, no scroll jank during the fill, and memoized so
// re-opening a topic is instant.
const streamedSource = (
  summaryReader: IndexedReader,
  url: string,
  blob: Blob | undefined,
  onProgress?: ProgressCallback,
): McapWorkbookSource => {
  const cache = new Map<string, Promise<TopicWorksheet>>();
  return {
    topics: buildTopicSummaries(summaryReader),
    ranged: false,
    coalesced: true,
    loadTopic: (topic, onPartial) => {
      const existing = cache.get(topic);
      if (existing) {
        return existing;
      }
      const pending = decodeTopic(spec(url, blob, topic), onPartial, onProgress);
      cache.set(topic, pending);
      return pending;
    },
  };
};

// One sequential GET, streamed through the decoder. `topic` (when set) bounds the
// pass to a single topic's rows; `onPartial` emits progressive snapshots.
const streamUrl = (
  url: string,
  phase: ProgressPhase,
  onProgress?: ProgressCallback,
  topic?: string,
  onPartial?: (worksheets: TopicWorksheet[]) => void,
): Promise<TopicWorksheet[]> =>
  fetchSlices(url).then(({ slices, total }) =>
    streamWorksheets(slices, { total, phase, onProgress, topic, onPartial }),
  );

// A local Blob/File, read sequentially through the decoder.
const streamBlob = (
  blob: Blob,
  phase: ProgressPhase,
  onProgress?: ProgressCallback,
  topic?: string,
  onPartial?: (worksheets: TopicWorksheet[]) => void,
): Promise<TopicWorksheet[]> =>
  streamWorksheets(slicesFromBlob(blob), { total: blob.size, phase, onProgress, topic, onPartial });

// --- Recovery (truncated / unindexed files) ---

/**
 * Recovers readable records from a (possibly truncated) MCAP buffer by streaming
 * from the start — no footer/index required. Keeps every complete record up to
 * the truncation point; the incomplete tail is dropped. Exported for tests.
 */
export const recoverFromBytes = (
  bytes: Uint8Array,
  options: OpenMcapOptions = {},
): Promise<TopicWorksheet[]> =>
  streamWorksheets(slicesFromBytes(bytes), {
    total: bytes.length,
    phase: 'recovering',
    onProgress: options.onProgress,
  });

// --- Public entry points ---

/**
 * Opens an MCAP file for lazy reading. Reads only the summary section up front
 * (leveraging HTTP range requests when the server supports them) to list topics;
 * each topic's rows are decoded on demand. Chunk-dense files (many small chunks,
 * where per-chunk reads would be thousands of serial round-trips) are decoded via
 * a single sequential streaming pass — one GET, memory-bounded, at any file size.
 * Truncated/unindexed files fall back to streaming recovery.
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
      const worksheets = await streamUrl(url, 'recovering', options.onProgress);
      return sourceFromWorksheets(worksheets, { recovered: true });
    } catch {
      throw indexedError;
    }
  }

  const { reader, ranged } = created;
  if (isChunkDense(reader.chunkIndexes.length, averageChunkBytes(reader))) {
    return streamedSource(reader, url, undefined, options.onProgress);
  }
  return sourceFromReader(reader, ranged);
};

/**
 * Opens an MCAP file from a local `Blob`/`File` (e.g. a file picker), reading it
 * entirely in the browser with no upload or server round-trip. Chunk-dense files
 * are decoded via a single sequential pass over the file; truncated/unindexed
 * files fall back to streaming recovery.
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
    if (isChunkDense(reader.chunkIndexes.length, averageChunkBytes(reader))) {
      return streamedSource(reader, '', blob, options.onProgress);
    }
    return sourceFromReader(reader, false);
  } catch (indexedError) {
    try {
      const worksheets = await streamBlob(blob, 'recovering', options.onProgress);
      return sourceFromWorksheets(worksheets, { recovered: true });
    } catch {
      throw indexedError;
    }
  }
};
