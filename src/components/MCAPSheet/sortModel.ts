import { asNumeric } from '../../lib/mcap/columnTypes';
import type { CellValue } from '../../lib/mcap/worksheet';

export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  column: string;
  direction: SortDirection;
}

/**
 * Returns a new array of row indices sorted by `sort` (or the input unchanged
 * when `sort` is null). `valueAt` reads a row's cell in the sort column.
 * Numeric/timestamp columns are compared numerically, others lexically; empty
 * cells (null/undefined) always sort last regardless of direction — matching
 * spreadsheet behavior.
 */
export const sortRowIndices = (
  indices: number[],
  sort: SortSpec | null,
  numeric: boolean,
  valueAt: (rowIndex: number) => CellValue,
): number[] => {
  if (!sort) {
    return indices;
  }

  const dir = sort.direction === 'asc' ? 1 : -1;

  return [...indices].sort((a, b) => {
    const av = valueAt(a);
    const bv = valueAt(b);
    const aEmpty = av === null || av === undefined;
    const bEmpty = bv === null || bv === undefined;
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    const cmp = numeric
      ? (asNumeric(av) ?? 0) - (asNumeric(bv) ?? 0)
      : String(av).localeCompare(String(bv));
    return cmp * dir;
  });
};

/** Cycles a column through asc → desc → unsorted, as an Excel-style toggle. */
export const cycleSort = (current: SortSpec | null, column: string): SortSpec | null => {
  if (!current || current.column !== column) {
    return { column, direction: 'asc' };
  }
  if (current.direction === 'asc') {
    return { column, direction: 'desc' };
  }
  return null;
};
