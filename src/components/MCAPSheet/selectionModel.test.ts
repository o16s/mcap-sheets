import { describe, expect, it } from 'vitest';
import {
  cellKey,
  fromSelection,
  parseCellKey,
  rectangleCells,
  toSelection,
} from './selectionModel';

describe('cellKey / parseCellKey', () => {
  it('round-trips, preserving columns that contain a pipe-like name', () => {
    expect(cellKey(3, 'a.b')).toBe('3|a.b');
    expect(parseCellKey('3|a.b')).toEqual({ rowIndex: 3, column: 'a.b' });
    // Column name containing "|" survives because only the first separator splits.
    expect(parseCellKey(cellKey(5, 'x|y'))).toEqual({ rowIndex: 5, column: 'x|y' });
  });
});

describe('toSelection / fromSelection', () => {
  it('round-trips a set of keys through a selection', () => {
    const keys = new Set([cellKey(1, 'a'), cellKey(2, 'b')]);
    const selection = toSelection(keys);
    expect(selection.cells).toHaveLength(2);
    expect(fromSelection(selection)).toEqual(keys);
  });
});

describe('rectangleCells', () => {
  const rowDisplayOrder = [10, 11, 12, 13]; // original indices in display order
  const visibleColumns = ['a', 'b', 'c'];

  it('spans the rectangle between anchor and focus in display/visible order', () => {
    const keys = rectangleCells(
      { rowIndex: 11, column: 'a' },
      { rowIndex: 12, column: 'b' },
      rowDisplayOrder,
      visibleColumns,
    );
    expect(new Set(keys)).toEqual(
      new Set([cellKey(11, 'a'), cellKey(11, 'b'), cellKey(12, 'a'), cellKey(12, 'b')]),
    );
  });

  it('is order-independent (focus before anchor)', () => {
    const forward = rectangleCells(
      { rowIndex: 10, column: 'a' },
      { rowIndex: 12, column: 'c' },
      rowDisplayOrder,
      visibleColumns,
    );
    const backward = rectangleCells(
      { rowIndex: 12, column: 'c' },
      { rowIndex: 10, column: 'a' },
      rowDisplayOrder,
      visibleColumns,
    );
    expect(new Set(forward)).toEqual(new Set(backward));
    expect(forward).toHaveLength(9);
  });

  it('returns empty when an endpoint is not in the current display (filtered out)', () => {
    expect(
      rectangleCells(
        { rowIndex: 99, column: 'a' },
        { rowIndex: 12, column: 'b' },
        rowDisplayOrder,
        visibleColumns,
      ),
    ).toEqual([]);
  });
});
