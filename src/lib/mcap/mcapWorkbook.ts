import { BlobReadable } from '@mcap/browser';
import { McapIndexedReader, type DecompressHandlers, type IReadable } from '@mcap/core';
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

const buildReadable = async (
  url: string,
): Promise<{ readable: IReadable; ranged: boolean }> => {
  const probe = await probeRangeSupport(url);

  if (probe.supported && probe.size !== undefined && probe.size >= BigInt(MIN_RANGE_BYTES)) {
    const ranged = new CachingReadable(new RangeReadable(url, probe.size), RANGE_CACHE_BYTES);
    return { readable: ranged, ranged: true };
  }

  // Fall back to downloading the whole file (small file, no range support, or
  // an unknown size).
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch MCAP file (${response.status})`);
  }
  const blob = await response.blob();
  return { readable: new BlobReadable(blob), ranged: false };
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
      // Preserve an existing count if another channel on this topic had one.
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
  const accumulator: TopicAccumulator = {
    columns: new Set<string>([LOG_TIME_COLUMN, PUBLISH_TIME_COLUMN]),
    rows: [],
  };

  for await (const message of reader.readMessages({ topics: [topic] })) {
    const channel = reader.channelsById.get(message.channelId);
    if (!channel) {
      continue;
    }

    const schema = reader.schemasById.get(channel.schemaId);
    const shouldParseJson =
      channel.messageEncoding.includes('json') || schema?.encoding?.includes('json') || false;

    const decoded = decodePayload(message.data, shouldParseJson);
    const flattened = flattenJsonPayload(decoded);
    // Inject the message timestamps after the payload so they remain the
    // authoritative record time even if a payload field shares the name.
    const row: Record<string, CellValue> = {
      ...flattened,
      [LOG_TIME_COLUMN]: message.logTime.toString(),
      [PUBLISH_TIME_COLUMN]: message.publishTime.toString(),
    };

    Object.keys(row).forEach((column) => accumulator.columns.add(column));
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

/**
 * Opens an MCAP file for lazy reading. Reads only the summary section up front
 * (leveraging HTTP range requests when the server supports them) to list
 * topics; each topic's rows are decoded on demand via {@link McapWorkbookSource.loadTopic}.
 */
export const openMcapWorkbook = async (url: string): Promise<McapWorkbookSource> => {
  const { reader, ranged } = await createReader(url);
  return sourceFromReader(reader, ranged);
};

/**
 * Opens an MCAP file from a local `Blob`/`File` (e.g. a file picker), reading it
 * entirely in the browser with no upload or server round-trip.
 */
export const openMcapWorkbookFromBlob = async (blob: Blob): Promise<McapWorkbookSource> => {
  const reader = await McapIndexedReader.Initialize({
    readable: new BlobReadable(blob),
    decompressHandlers,
    messageIndexCacheSizeBytes: MESSAGE_INDEX_CACHE_BYTES,
  });
  return sourceFromReader(reader, false);
};
