import { describe, expect, it } from 'vitest';
import { McapWriter, TempBuffer } from '@mcap/core';
import { isChunkDense, recoverFromBytes } from './mcapWorkbook';

const te = new TextEncoder();

// Builds a small, valid, indexed MCAP (2 topics, JSON messages) in memory.
async function buildMcap(): Promise<Uint8Array> {
  const buffer = new TempBuffer();
  const writer = new McapWriter({ writable: buffer });
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

  for (let i = 0; i < 5; i += 1) await add(a, i, i);
  for (let i = 0; i < 3; i += 1) await add(b, 100 + i, i);
  await writer.end();
  return buffer.get();
}

describe('recoverFromBytes', () => {
  it('recovers all topics/rows from a complete file', async () => {
    const sheets = await recoverFromBytes(await buildMcap());
    const counts = Object.fromEntries(sheets.map((s) => [s.topic, s.rows.length]));
    expect(counts).toEqual({ '/a': 5, '/b': 3 });
    const a = sheets.find((s) => s.topic === '/a')!;
    expect(a.columns).toContain('v');
    expect(a.columns).toContain('log_time');
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

    const total = sheets.reduce((n, s) => n + s.rows.length, 0);
    expect(total).toBeGreaterThan(0); // messages recovered despite the missing footer
    expect(lastFraction).toBeGreaterThan(0.9);
  });
});

describe('isChunkDense', () => {
  it('coalesces many small chunks, but not few chunks or oversized files', () => {
    expect(isChunkDense(678, 5_316_571)).toBe(true); // the real repro
    expect(isChunkDense(4, 5_000_000)).toBe(false); // few chunks → keep range
    expect(isChunkDense(1000, 300 * 1024 * 1024)).toBe(false); // over the 256 MiB cap
  });
});
