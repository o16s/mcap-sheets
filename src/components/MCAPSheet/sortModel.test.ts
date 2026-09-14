import { describe, expect, it } from 'vitest';
import { cycleSort, sortRows, type SortSpec } from './sortModel';

type Row = { n: number | string | null; s: string | null };

const rows: Row[] = [
  { n: 2, s: 'banana' },
  { n: 10, s: 'apple' },
  { n: null, s: 'cherry' },
];

describe('sortRows', () => {
  it('returns the input unchanged when unsorted', () => {
    expect(sortRows(rows, null, true)).toBe(rows);
  });

  it('sorts numeric columns numerically (not lexically), empties last', () => {
    const asc = sortRows(rows, { column: 'n', direction: 'asc' }, true).map((r) => r.n);
    expect(asc).toEqual([2, 10, null]);
    const desc = sortRows(rows, { column: 'n', direction: 'desc' }, true).map((r) => r.n);
    expect(desc).toEqual([10, 2, null]); // empties stay last even descending
  });

  it('sorts text columns lexically', () => {
    const asc = sortRows(rows, { column: 's', direction: 'asc' }, false).map((r) => r.s);
    expect(asc).toEqual(['apple', 'banana', 'cherry']);
  });

  it('does not mutate the input array', () => {
    const copy = [...rows];
    sortRows(rows, { column: 'n', direction: 'asc' }, true);
    expect(rows).toEqual(copy);
  });
});

describe('cycleSort', () => {
  it('cycles a column asc → desc → unsorted', () => {
    let sort: SortSpec | null = null;
    sort = cycleSort(sort, 'n');
    expect(sort).toEqual({ column: 'n', direction: 'asc' });
    sort = cycleSort(sort, 'n');
    expect(sort).toEqual({ column: 'n', direction: 'desc' });
    sort = cycleSort(sort, 'n');
    expect(sort).toBeNull();
  });

  it('starts fresh (asc) when switching to a different column', () => {
    expect(cycleSort({ column: 'n', direction: 'desc' }, 's')).toEqual({
      column: 's',
      direction: 'asc',
    });
  });
});
