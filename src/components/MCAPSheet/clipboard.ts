import { cellKey, parseCellKey } from './selectionModel';

// TSV values containing a tab/newline/quote are wrapped in double quotes (with
// internal quotes doubled) so spreadsheets parse them into a single cell.
const tsvEscape = (value: string): string =>
  /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const htmlEscape = (value: string): string =>
  value.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));

export interface ClipboardTable {
  /** Tab-separated values (rows joined by newlines) — pastes into Excel/Sheets. */
  text: string;
  /** An HTML table — spreadsheets prefer this for exact cell structure. */
  html: string;
}

/**
 * Serializes a cell selection into a rectangular clipboard payload. The
 * rectangle spans the bounding box of the selection in display-row × visible-
 * column order; cells inside the box that aren't selected are emitted empty.
 * Returns null when nothing (in view) is selected.
 */
export const buildClipboardTable = (
  selection: Set<string>,
  rowDisplayOrder: number[],
  visibleColumns: string[],
  getText: (rowIndex: number, column: string) => string,
): ClipboardTable | null => {
  if (selection.size === 0) {
    return null;
  }

  const rowPos = new Map(rowDisplayOrder.map((rowIndex, position) => [rowIndex, position]));
  const colPos = new Map(visibleColumns.map((column, position) => [column, position]));

  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;

  for (const key of selection) {
    const { rowIndex, column } = parseCellKey(key);
    const rowPosition = rowPos.get(rowIndex);
    const colPosition = colPos.get(column);
    if (rowPosition === undefined || colPosition === undefined) {
      continue; // filtered out or hidden — not part of the visible copy
    }
    minRow = Math.min(minRow, rowPosition);
    maxRow = Math.max(maxRow, rowPosition);
    minCol = Math.min(minCol, colPosition);
    maxCol = Math.max(maxCol, colPosition);
  }

  if (minRow === Infinity) {
    return null;
  }

  const textRows: string[] = [];
  const htmlRows: string[] = [];

  for (let r = minRow; r <= maxRow; r += 1) {
    const rowIndex = rowDisplayOrder[r];
    const textCells: string[] = [];
    const htmlCells: string[] = [];
    for (let c = minCol; c <= maxCol; c += 1) {
      const column = visibleColumns[c];
      const value = selection.has(cellKey(rowIndex, column)) ? getText(rowIndex, column) : '';
      textCells.push(tsvEscape(value));
      htmlCells.push(`<td>${htmlEscape(value)}</td>`);
    }
    textRows.push(textCells.join('\t'));
    htmlRows.push(`<tr>${htmlCells.join('')}</tr>`);
  }

  return { text: textRows.join('\n'), html: `<table>${htmlRows.join('')}</table>` };
};
