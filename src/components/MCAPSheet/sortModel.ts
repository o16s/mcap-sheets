import { asNumeric } from '../../lib/mcap/columnTypes';
import type { CellValue } from '../../lib/mcap/worksheet';

export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  column: string;
  direction: SortDirection;
}

/**
 * Returns a new array of rows sorted by `sort` (or the input unchanged when
 * `sort` is null). Numeric/timestamp columns are compared numerically, others
 * lexically; empty cells (null/undefined) always sort last regardless of
 * direction — matching spreadsheet behavior.
 */
export const sortRows = <T extends Record<string, CellValue>>(
  rows: T[],
  sort: SortSpec | null,
  numeric: boolean,
): T[] => {
  if (!sort) {
    return rows;
  }

  const { column, direction } = sort;
  const dir = direction === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    const av = a[column];
    const bv = b[column];
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
