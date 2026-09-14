import { describe, expect, it } from 'vitest';
import { buildClipboardTable } from './clipboard';
import { cellKey } from './selectionModel';

const rowDisplayOrder = [10, 11, 12];
const visibleColumns = ['a', 'b', 'c'];
const getText = (rowIndex: number, column: string) => `${column}${rowIndex}`;

describe('buildClipboardTable', () => {
  it('returns null for an empty selection', () => {
    expect(buildClipboardTable(new Set(), rowDisplayOrder, visibleColumns, getText)).toBeNull();
  });

  it('serializes a rectangular selection as TSV + HTML', () => {
    const selection = new Set([
      cellKey(10, 'a'),
      cellKey(10, 'b'),
      cellKey(11, 'a'),
      cellKey(11, 'b'),
    ]);
    const table = buildClipboardTable(selection, rowDisplayOrder, visibleColumns, getText)!;
    expect(table.text).toBe('a10\tb10\na11\tb11');
    expect(table.html).toBe('<table><tr><td>a10</td><td>b10</td></tr><tr><td>a11</td><td>b11</td></tr></table>');
  });

  it('fills non-selected cells inside the bounding box as empty', () => {
    // Diagonal selection → bounding box is 2×2 with two blanks.
    const selection = new Set([cellKey(10, 'a'), cellKey(11, 'b')]);
    const table = buildClipboardTable(selection, rowDisplayOrder, visibleColumns, getText)!;
    expect(table.text).toBe('a10\t\n\tb11');
  });

  it('quotes values containing tabs or newlines', () => {
    const selection = new Set([cellKey(10, 'a')]);
    const table = buildClipboardTable(selection, rowDisplayOrder, visibleColumns, () => 'x\ty')!;
    expect(table.text).toBe('"x\ty"');
  });

  it('ignores selected cells that are filtered out / hidden', () => {
    const selection = new Set([cellKey(10, 'a'), cellKey(99, 'a')]);
    const table = buildClipboardTable(selection, rowDisplayOrder, visibleColumns, getText)!;
    expect(table.text).toBe('a10');
  });
});
