import { describe, expect, it } from 'vitest';
import {
  flattenJsonPayload,
  formatTimestamp,
  LOG_TIME_COLUMN,
  normalizeTopicAccumulator,
  PUBLISH_TIME_COLUMN,
  type CellValue,
  type TopicAccumulator,
} from './worksheet';

describe('flattenJsonPayload', () => {
  it('flattens nested objects using dot notation', () => {
    expect(
      flattenJsonPayload({
        field: {
          key1: {
            key2: {
              varname: 42,
            },
          },
        },
      }),
    ).toEqual({
      'field.key1.key2.varname': 42,
    });
  });

  it('flattens arrays while preserving indexes', () => {
    expect(
      flattenJsonPayload({
        values: [{ x: 1 }, { x: 2 }],
      }),
    ).toEqual({
      'values.0.x': 1,
      'values.1.x': 2,
    });
  });
});

describe('normalizeTopicAccumulator', () => {
  it('orders timestamp columns first, carrying column-major data through', () => {
    const columnData = new Map<string, CellValue[]>([
      [LOG_TIME_COLUMN, ['1']],
      ['a', ['x']],
    ]);
    const accumulator: TopicAccumulator = {
      columns: new Set(['b', PUBLISH_TIME_COLUMN, 'a', LOG_TIME_COLUMN]),
      columnData,
      rowCount: 1,
    };

    const result = normalizeTopicAccumulator(accumulator);
    // Timestamp columns lead, then the rest alphabetically.
    expect(result.columns).toEqual([LOG_TIME_COLUMN, PUBLISH_TIME_COLUMN, 'a', 'b']);
    expect(result.rowCount).toBe(1);
    // Data is carried through as-is (no row objects materialized, no null-fill).
    expect(result.columnData).toBe(columnData);
  });
});

describe('formatTimestamp', () => {
  it('renders nanosecond timestamps as ISO 8601', () => {
    // 2026-09-12T09:14:35.000Z in nanoseconds since the Unix epoch.
    const nanos = BigInt(Date.UTC(2026, 8, 12, 9, 14, 35)) * 1_000_000n;
    expect(formatTimestamp(nanos.toString())).toBe('2026-09-12T09:14:35.000Z');
  });

  it('returns empty string for empty cells and passes through non-timestamps', () => {
    expect(formatTimestamp(null)).toBe('');
    expect(formatTimestamp('')).toBe('');
    expect(formatTimestamp('not-a-number')).toBe('not-a-number');
  });
});
