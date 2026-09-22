import { describe, expect, it } from 'vitest';
import { McapWriter, TempBuffer } from '@mcap/core';
import { isChunkDense, openMcapWorkbookFromBlob, recoverFromBytes } from './mcapWorkbook';

const te = new TextEncoder();

interface BuildOptions {
  aCount?: number;
  bCount?: number;
  /** Small values force a chunk boundary per message → a chunk-dense file. */
  chunkSize?: number;
}

// Builds a small, valid, indexed MCAP (2 topics, JSON messages) in memory.
async function buildMcap({ aCount = 5, bCount = 3, chunkSize }: BuildOptions = {}): Promise<Uint8Array> {
  const buffer = new TempBuffer();
  const writer = new McapWriter({ writable: buffer, chunkSize });
  await writer.start({ profile: '', library: 'test' });
  const schemaId = await writer.registerSchema({
    name: 'S',
    encoding: 'jsonschema',
    data: te.encode('{}'),
  });
  const a = await writer.registerChannel({
    schemaId,
    topic: '/a',
    messageEncoding: 'json',
    metadata: new Map(),
  });
  const b = await writer.registerChannel({
    schemaId,
    topic: '/b',
    messageEncoding: 'json',
    metadata: new Map(),
  });

  let seq = 0;
  const add = async (channelId: number, time: number, v: number) =>
    writer.addMessage({
      channelId,
      sequence: seq++,
      logTime: BigInt(time),
      publishTime: BigInt(time),
      data: te.encode(JSON.stringify({ v })),
    });

  for (let i = 0; i < aCount; i += 1) await add(a, i, i);
  for (let i = 0; i < bCount; i += 1) await add(b, 100 + i, i);
  await writer.end();
  return buffer.get();
}

describe('recoverFromBytes', () => {
  it('recovers all topics/rows from a complete file', async () => {
    const sheets = await recoverFromBytes(await buildMcap());
    const counts = Object.fromEntries(sheets.map((s) => [s.topic, s.rowCount]));
    expect(counts).toEqual({ '/a': 5, '/b': 3 });
    const a = sheets.find((s) => s.topic === '/a')!;
    expect(a.columns).toContain('v');
    expect(a.columns).toContain('log_time');
    // Column-major data: the 'v' column holds one value per row.
    expect(a.columnData.get('v')).toHaveLength(5);
  });

  it('recovers records up to the truncation point and reports progress', async () => {
    const bytes = await buildMcap();
    // Chop the footer + closing magic (the data chunk stays intact).
    const truncated = bytes.subarray(0, bytes.length - 32);

    let lastFraction = 0;
    const sheets = await recoverFromBytes(truncated, {
      onProgress: (p) => {
        lastFraction = p.fraction;
      },
    });

    const total = sheets.reduce((n, s) => n + s.rowCount, 0);
    expect(total).toBeGreaterThan(0); // messages recovered despite the missing footer
    expect(lastFraction).toBeGreaterThan(0.9);
  });
});

describe('chunk-dense source (per-topic streaming)', () => {
  it('detects density and reads each topic independently (bounded memory)', async () => {
    // chunkSize:1 forces a chunk per message → >16 tiny chunks → chunk-dense.
    const bytes = await buildMcap({ aCount: 20, bCount: 10, chunkSize: 1 });
    const source = await openMcapWorkbookFromBlob(new Blob([bytes as BlobPart]));

    // Routed through the sequential streaming pass, not the per-chunk range path.
    expect(source.coalesced).toBe(true);
    expect(source.topics.map((t) => t.topic).sort()).toEqual(['/a', '/b']);

    // Each topic's pass yields only that topic's rows, and emits at least one
    // progressive snapshot (instant first paint) before resolving.
    const snapshots: number[] = [];
    const a = await source.loadTopic('/a', (partial) => snapshots.push(partial.rowCount));
    expect(a.rowCount).toBe(20);
    expect(a.columns).toContain('v');
    expect(a.columnData.get('v')).toHaveLength(20);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)).toBeLessThanOrEqual(20);

    const b = await source.loadTopic('/b');
    expect(b.rowCount).toBe(10);
  });
});

describe('isChunkDense', () => {
  const KiB = 1024;
  const MiB = 1024 * 1024;

  it('streams many small chunks (round-trip bound), regardless of total size', () => {
    expect(isChunkDense(678, 7.8 * KiB)).toBe(true); // 5.3 MB / 678 chunks (first repro)
    expect(isChunkDense(33_334, 9.5 * KiB)).toBe(true); // 307 MiB / 33k tiny chunks
  });

  it('keeps the lazy range path for few chunks or large chunks', () => {
    expect(isChunkDense(16, 8 * KiB)).toBe(false); // at the count threshold
    expect(isChunkDense(4, 8 * KiB)).toBe(false); // few chunks
    // Many chunks but each large (e.g. a healthy 2 GB / 500 × 4 MiB file): each
    // round-trip is well amortized, so lazily reading one topic still wins.
    expect(isChunkDense(500, 4 * MiB)).toBe(false);
  });
});
