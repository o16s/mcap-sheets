import { describe, expect, it } from 'vitest';
import { asNumeric, cellKey, ENUM_MAX_DISTINCT, inferColumnType } from './columnTypes';

describe('asNumeric', () => {
  it('accepts numbers and numeric strings, including big timestamps', () => {
    expect(asNumeric(42)).toBe(42);
    expect(asNumeric(-3.5)).toBe(-3.5);
    expect(asNumeric('1730000000000000000')).toBe(1730000000000000000);
    expect(asNumeric('1e3')).toBe(1000);
  });

  it('rejects non-numeric strings, booleans and null', () => {
    expect(asNumeric('123 Main St')).toBeNull();
    expect(asNumeric('')).toBeNull();
    expect(asNumeric(true)).toBeNull();
    expect(asNumeric(null)).toBeNull();
  });
});

describe('cellKey', () => {
  it('distinguishes types and the empty cell', () => {
    expect(cellKey(1)).not.toBe(cellKey('1'));
    expect(cellKey(null)).not.toBe(cellKey('null'));
    expect(cellKey(true)).toBe(cellKey(true));
  });
});

describe('inferColumnType', () => {
  it('detects a numeric range and ignores nulls', () => {
    expect(inferColumnType([3, 1, null, 2])).toEqual({ kind: 'number', min: 1, max: 3 });
  });

  it('treats numeric strings as a numeric range', () => {
    expect(inferColumnType(['10', '2', '30'])).toEqual({ kind: 'number', min: 2, max: 30 });
  });

  it('detects discrete enum columns and sorts the values', () => {
    expect(inferColumnType(['b', 'a', 'a', 'c'])).toEqual({
      kind: 'enum',
      values: ['a', 'b', 'c'],
    });
  });

  it('treats booleans as a discrete enum', () => {
    expect(inferColumnType([true, false, true])).toEqual({
      kind: 'enum',
      values: [false, true],
    });
  });

  it('falls back to text when there are too many distinct values', () => {
    const many = Array.from({ length: ENUM_MAX_DISTINCT + 1 }, (_unused, index) => `v${index}`);
    expect(inferColumnType(many)).toEqual({ kind: 'text' });
  });

  it('returns text for an all-null / empty column', () => {
    expect(inferColumnType([null, null])).toEqual({ kind: 'text' });
    expect(inferColumnType([])).toEqual({ kind: 'text' });
  });
});
