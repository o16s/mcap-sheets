// Worker-safe MCAP streaming decode. Deliberately self-contained (no DOM, no
// range readers, no imports from mcapWorkbook) so it can run inside a Web Worker
// as well as on the main thread. It streams a file front-to-back through
// McapStreamReader and emits *column-major batches* of decoded rows, so neither
// the worker nor the transfer ever materializes per-row objects.
import {
  McapStreamReader,
  type DecompressHandlers,
  type TypedMcapRecord,
} from '@mcap/core';
import lz4js from 'lz4js';
import { decompress as decompressZstd } from 'fzstd';
import {
  flattenJsonPayload,
  LOG_TIME_COLUMN,
  PUBLISH_TIME_COLUMN,
  type CellValue,
} from './worksheet';

export const decompressHandlers: DecompressHandlers = {
  lz4: (buffer) => new Uint8Array(lz4js.decompress(buffer)),
  zstd: (buffer) => decompressZstd(buffer),
};

const textDecoder = new TextDecoder();

const decodePayload = (data: Uint8Array, asJson: boolean): unknown => {
  if (asJson) {
    const decoded = textDecoder.decode(data);
    try {
      return JSON.parse(decoded);
    } catch {
      return decoded;
    }
  }
  return btoa(String.fromCharCode(...data));
};

const shouldParseJson = (
  channel: { messageEncoding: string },
  schema: { encoding?: string } | undefined,
): boolean =>
  channel.messageEncoding.includes('json') || schema?.encoding?.includes('json') || false;

/** Flattens one message into a flat {column: value} row (timestamps injected last). */
export const messageToRow = (
  message: { data: Uint8Array; logTime: bigint; publishTime: bigint },
  channel: { messageEncoding: string },
  schema: { encoding?: string } | undefined,
): Record<string, CellValue> => {
  const decoded = decodePayload(message.data, shouldParseJson(channel, schema));
  const flattened = flattenJsonPayload(decoded);
  return {
    ...flattened,
    [LOG_TIME_COLUMN]: message.logTime.toString(),
    [PUBLISH_TIME_COLUMN]: message.publishTime.toString(),
  };
};

// --- Slice sources ---

const SLICE_BYTES = 4 * 1024 * 1024;

export async function* slicesFromBytes(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += SLICE_BYTES) {
    yield bytes.subarray(offset, Math.min(offset + SLICE_BYTES, bytes.length));
  }
}

export async function* slicesFromBlob(blob: Blob): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < blob.size; offset += SLICE_BYTES) {
    const end = Math.min(offset + SLICE_BYTES, blob.size);
    yield new Uint8Array(await blob.slice(offset, end).arrayBuffer());
  }
}

async function* slicesFromStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    yield value;
  }
}

/** One HTTP GET, consumed sequentially (bounded memory), with a buffered fallback. */
export const fetchSlices = async (
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

// --- Streaming decode → column batches ---

/**
 * A batch of newly-decoded rows in column-major form. `data` is [column, values]
 * pairs where `values[i]` is the cell for row `start + i` (a hole/undefined means
 * that row lacked the column). Cheap to postMessage and to append on the main
 * thread — no row objects ever cross the boundary.
 */
export interface DecodeBatch {
  start: number;
  count: number;
  data: Array<[string, CellValue[]]>;
}

const YIELD_BYTES = 4 * 1024 * 1024; // progress/UI-yield cadence
const FLUSH_BYTES = 16 * 1024 * 1024; // batch-emit cadence (after the first)
const BATCH_ROW_CAP = 20_000; // hard cap so a batch can't grow unbounded
const yieldToMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface StreamDecodeOptions {
  topic?: string;
  total: number;
  onBatch: (batch: DecodeBatch) => void;
  onProgress?: (fraction: number) => void;
  /** Yield to the event loop between slices (true on the main thread; false in a worker). */
  yieldBetween?: boolean;
}

type SchemaRecord = Extract<TypedMcapRecord, { type: 'Schema' }>;
type ChannelRecord = Extract<TypedMcapRecord, { type: 'Channel' }>;

/**
 * Streams `slices` through McapStreamReader, decoding `topic`'s messages into
 * column-major batches emitted via `onBatch`. The first batch is emitted as soon
 * as any rows exist (instant first paint), then coarsely thereafter. Keeps every
 * complete record up to a parse error (a truncated tail); resolves when the
 * stream ends.
 */
export const streamDecode = async (
  slices: AsyncIterable<Uint8Array>,
  { topic, total, onBatch, onProgress, yieldBetween = true }: StreamDecodeOptions,
): Promise<void> => {
  const reader = new McapStreamReader({ decompressHandlers, validateCrcs: false });
  const schemas = new Map<number, SchemaRecord>();
  const channels = new Map<number, ChannelRecord>();

  let consumed = 0;
  let reported = 0;
  let lastFlush = 0;
  let emittedFirst = false;

  let start = 0;
  let batchCount = 0;
  const batchCols = new Map<string, CellValue[]>();

  const flush = () => {
    if (batchCount === 0) {
      return;
    }
    const data: Array<[string, CellValue[]]> = [];
    for (const [column, values] of batchCols) {
      data.push([column, values]);
    }
    onBatch({ start, count: batchCount, data });
    start += batchCount;
    batchCount = 0;
    batchCols.clear();
  };

  const addRow = (row: Record<string, CellValue>) => {
    const j = batchCount;
    for (const column of Object.keys(row)) {
      let values = batchCols.get(column);
      if (!values) {
        values = [];
        batchCols.set(column, values);
      }
      values[j] = row[column];
    }
    batchCount += 1;
    if (batchCount >= BATCH_ROW_CAP) {
      flush();
    }
  };

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
            addRow(messageToRow(record, channel, schemas.get(channel.schemaId)));
          }
        }
      }
    } catch {
      truncated = true;
    }

    if (truncated) {
      break;
    }

    let worked = false;
    if (consumed - reported >= YIELD_BYTES) {
      reported = consumed;
      onProgress?.(total ? Math.min(1, consumed / total) : 1);
      worked = true;
    }
    // Emit the first batch as soon as rows exist (instant first paint), then
    // every FLUSH_BYTES.
    if (batchCount > 0 && (!emittedFirst || consumed - lastFlush >= FLUSH_BYTES)) {
      emittedFirst = true;
      lastFlush = consumed;
      flush();
      worked = true;
    }
    if (worked && yieldBetween) {
      await yieldToMacrotask();
    }
  }

  flush();
  onProgress?.(total ? Math.min(1, consumed / total) : 1);
};
