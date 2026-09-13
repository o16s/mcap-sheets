import type { CellValue } from '../../lib/mcap/worksheet';
import { asNumeric, cellKey, type ColumnType } from '../../lib/mcap/columnTypes';

export type ColumnFilterValue =
  | { kind: 'text'; query: string }
  | { kind: 'number'; min: string; max: string }
  | { kind: 'enum'; selected: Set<string> };

const toCellText = (value: CellValue): string => (value === null ? '' : String(value));

/**
 * Builds a row predicate for a single column's active filter, or `null` when
 * the filter is inactive (empty text, no bounds, or all enum values selected).
 */
export const buildColumnPredicate = (
  filter: ColumnFilterValue | undefined,
  type: ColumnType | undefined,
): ((value: CellValue) => boolean) | null => {
  if (!filter) {
    return null;
  }

  if (filter.kind === 'text') {
    const query = filter.query.trim().toLowerCase();
    if (!query) {
      return null;
    }
    return (value) => toCellText(value).toLowerCase().includes(query);
  }

  if (filter.kind === 'number') {
    const minText = filter.min.trim();
    const maxText = filter.max.trim();
    const min = minText === '' ? null : Number(minText);
    const max = maxText === '' ? null : Number(maxText);
    const hasMin = min !== null && Number.isFinite(min);
    const hasMax = max !== null && Number.isFinite(max);
    if (!hasMin && !hasMax) {
      return null;
    }
    return (value) => {
      const numeric = asNumeric(value);
      if (numeric === null) {
        return false;
      }
      if (hasMin && numeric < (min as number)) {
        return false;
      }
      if (hasMax && numeric > (max as number)) {
        return false;
      }
      return true;
    };
  }

  // enum: inactive when every distinct value is still selected.
  const total = type?.kind === 'enum' ? type.values.length : undefined;
  if (total !== undefined && filter.selected.size >= total) {
    return null;
  }
  const selected = filter.selected;
  return (value) => selected.has(cellKey(value));
};
