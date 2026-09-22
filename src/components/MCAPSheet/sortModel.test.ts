import { describe, expect, it } from 'vitest';
import { cycleSort, sortRowIndices, type SortSpec } from './sortModel';
import type { CellValue } from '../../lib/mcap/worksheet';

// Column-major fixture: cell arrays indexed by row.
const n: CellValue[] = [2, 10, null];
const s: CellValue[] = ['banana', 'apple', 'cherry'];
const column: Record<string, CellValue[]> = { n, s };
const indices = [0, 1, 2];
const valueAt = (col: string) => (rowIndex: number) => column[col][rowIndex];

describe('sortRowIndices', () => {
  it('returns the input unchanged when unsorted', () => {
    expect(sortRowIndices(indices, null, true, valueAt('n'))).toBe(indices);
  });

  it('sorts numeric columns numerically (not lexically), empties last', () => {
    const asc = sortRowIndices(indices, { column: 'n', direction: 'asc' }, true, valueAt('n')).map(
      (i) => n[i],
    );
    expect(asc).toEqual([2, 10, null]);
    const desc = sortRowIndices(indices, { column: 'n', direction: 'desc' }, true, valueAt('n')).map(
      (i) => n[i],
    );
    expect(desc).toEqual([10, 2, null]); // empties stay last even descending
  });

  it('sorts text columns lexically', () => {
    const asc = sortRowIndices(indices, { column: 's', direction: 'asc' }, false, valueAt('s')).map(
      (i) => s[i],
    );
    expect(asc).toEqual(['apple', 'banana', 'cherry']);
  });

  it('does not mutate the input array', () => {
    const copy = [...indices];
    sortRowIndices(indices, { column: 'n', direction: 'asc' }, true, valueAt('n'));
    expect(indices).toEqual(copy);
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
