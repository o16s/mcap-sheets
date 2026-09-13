import { describe, expect, it } from 'vitest';
import { cellKey, type ColumnType } from '../../lib/mcap/columnTypes';
import { buildColumnPredicate } from './columnFilterModel';

describe('buildColumnPredicate', () => {
  it('returns null for missing or empty filters', () => {
    expect(buildColumnPredicate(undefined, { kind: 'text' })).toBeNull();
    expect(buildColumnPredicate({ kind: 'text', query: '   ' }, { kind: 'text' })).toBeNull();
    expect(buildColumnPredicate({ kind: 'number', min: '', max: '' }, undefined)).toBeNull();
  });

  it('matches text case-insensitively as a substring', () => {
    const predicate = buildColumnPredicate({ kind: 'text', query: 'ERR' }, { kind: 'text' });
    expect(predicate?.('error: boom')).toBe(true);
    expect(predicate?.('ok')).toBe(false);
    expect(predicate?.(null)).toBe(false);
  });

  it('applies numeric bounds inclusively and excludes non-numbers', () => {
    const type: ColumnType = { kind: 'number', min: 0, max: 100 };
    const both = buildColumnPredicate({ kind: 'number', min: '10', max: '20' }, type);
    expect(both?.(10)).toBe(true);
    expect(both?.(20)).toBe(true);
    expect(both?.(9.99)).toBe(false);
    expect(both?.('15')).toBe(true); // numeric strings compare
    expect(both?.('n/a')).toBe(false);
    expect(both?.(null)).toBe(false);

    const minOnly = buildColumnPredicate({ kind: 'number', min: '5', max: '' }, type);
    expect(minOnly?.(4)).toBe(false);
    expect(minOnly?.(5)).toBe(true);
  });

  it('is inactive when every enum value is still selected', () => {
    const type: ColumnType = { kind: 'enum', values: ['a', 'b'] };
    const all = new Set([cellKey('a'), cellKey('b')]);
    expect(buildColumnPredicate({ kind: 'enum', selected: all }, type)).toBeNull();
  });

  it('keeps only selected enum values', () => {
    const type: ColumnType = { kind: 'enum', values: ['a', 'b', 'c'] };
    const predicate = buildColumnPredicate(
      { kind: 'enum', selected: new Set([cellKey('a')]) },
      type,
    );
    expect(predicate?.('a')).toBe(true);
    expect(predicate?.('b')).toBe(false);
  });

  it('filters everything out when no enum value is selected', () => {
    const type: ColumnType = { kind: 'enum', values: ['a', 'b'] };
    const predicate = buildColumnPredicate({ kind: 'enum', selected: new Set() }, type);
    expect(predicate?.('a')).toBe(false);
    expect(predicate?.('b')).toBe(false);
  });
});
