import { describe, expect, it } from 'vitest';
import {
  flattenJsonPayload,
  LOG_TIME_COLUMN,
  normalizeTopicAccumulator,
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
  it('keeps _logTime first and null-fills missing columns', () => {
    const accumulator: TopicAccumulator = {
      columns: new Set([LOG_TIME_COLUMN, 'a', 'b']),
      rows: [{ _logTime: '1', a: 'x' }],
    };

    expect(normalizeTopicAccumulator(accumulator)).toEqual({
      columns: [LOG_TIME_COLUMN, 'a', 'b'],
      rows: [{ _logTime: '1', a: 'x', b: null }],
    });
  });
});
