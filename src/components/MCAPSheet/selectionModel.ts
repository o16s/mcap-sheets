export interface CellRef {
  /** Index into the current topic's UNFILTERED rows array. */
  rowIndex: number;
  column: string;
}

export interface MCAPSelection {
  cells: CellRef[];
}

/** Stable string key for a cell, used for O(1) selection/highlight lookups. */
export const cellKey = (rowIndex: number, column: string): string => `${rowIndex}|${column}`;

export const parseCellKey = (key: string): CellRef => {
  const separator = key.indexOf('|');
  return {
    rowIndex: Number(key.slice(0, separator)),
    column: key.slice(separator + 1),
  };
};

export const toSelection = (keys: Iterable<string>): MCAPSelection => ({
  cells: Array.from(keys, parseCellKey),
});

export const fromSelection = (selection: MCAPSelection): Set<string> =>
  new Set(selection.cells.map((cell) => cellKey(cell.rowIndex, cell.column)));

/**
 * Computes the set of cell keys inside the rectangle spanned by `anchor` and
 * `focus`, over the current display order of rows and the visible column order.
 * Both endpoints are original row indices; cells outside the current display
 * (filtered out) are ignored. Works purely on the model order — no DOM — so it
 * is correct even for rows/columns that aren't currently rendered.
 */
export const rectangleCells = (
  anchor: CellRef,
  focus: CellRef,
  rowDisplayOrder: number[],
  visibleColumns: string[],
): string[] => {
  const rowPos = new Map(rowDisplayOrder.map((rowIndex, position) => [rowIndex, position]));
  const colPos = new Map(visibleColumns.map((column, position) => [column, position]));

  const anchorRow = rowPos.get(anchor.rowIndex);
  const focusRow = rowPos.get(focus.rowIndex);
  const anchorCol = colPos.get(anchor.column);
  const focusCol = colPos.get(focus.column);

  if (
    anchorRow === undefined ||
    focusRow === undefined ||
    anchorCol === undefined ||
    focusCol === undefined
  ) {
    return [];
  }

  const [rowStart, rowEnd] = anchorRow <= focusRow ? [anchorRow, focusRow] : [focusRow, anchorRow];
  const [colStart, colEnd] = anchorCol <= focusCol ? [anchorCol, focusCol] : [focusCol, anchorCol];

  const keys: string[] = [];
  for (let r = rowStart; r <= rowEnd; r += 1) {
    const rowIndex = rowDisplayOrder[r];
    for (let c = colStart; c <= colEnd; c += 1) {
      keys.push(cellKey(rowIndex, visibleColumns[c]));
    }
  }
  return keys;
};
