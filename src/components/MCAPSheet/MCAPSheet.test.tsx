// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MCAPSheet } from './MCAPSheet';
import { LOG_TIME_COLUMN } from '../../lib/mcap/worksheet';
import type { MCAPSelection } from './types';
import type { TopicWorksheet } from './types';

// jsdom has no layout engine, so give TanStack Virtual a viewport + ResizeObserver
// so it actually renders the (few) data rows and their cells.
beforeAll(() => {
  // TanStack Virtual measures the scroll element via offsetWidth/offsetHeight,
  // which jsdom reports as 0. Give it a viewport + a ResizeObserver that fires,
  // so it actually renders the (few) data rows and their cells.
  globalThis.ResizeObserver = class {
    #cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.#cb = cb;
    }
    observe(target: Element) {
      this.#cb([{ target } as ResizeObserverEntry], this);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
});

const workbook: TopicWorksheet[] = [
  {
    topic: 'sensors',
    columns: [LOG_TIME_COLUMN, 'level', 'value'],
    rows: [
      { [LOG_TIME_COLUMN]: '1789204475071764755', level: 'info', value: 1 },
      { [LOG_TIME_COLUMN]: '1789204475171040750', level: 'warn', value: 2 },
    ],
  },
];

const loader = () => Promise.resolve(workbook);

const cellAt = (container: HTMLElement, rowIndex: number, column: string) =>
  container.querySelector<HTMLElement>(`[data-row-id="${rowIndex}"][data-col-id="${column}"]`);

afterEach(cleanup);

describe('MCAPSheet', () => {
  it('renders a header for each column once the workbook loads', async () => {
    render(<MCAPSheet url="mem://test.mcap" dataLoader={loader} />);

    await waitFor(() => expect(screen.getByText(LOG_TIME_COLUMN)).toBeTruthy());
    expect(screen.getByText('level')).toBeTruthy();
    expect(screen.getByText('value')).toBeTruthy();
    expect(screen.getByText('2 / 2 rows')).toBeTruthy();
  });

  it('hides a column via the right-click menu and restores it', async () => {
    render(<MCAPSheet url="mem://test.mcap" dataLoader={loader} />);

    const levelHeader = await screen.findByText('level');
    fireEvent.contextMenu(levelHeader);

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide "level"' }));
    await waitFor(() => expect(screen.queryByText('level')).toBeNull());

    fireEvent.contextMenu(screen.getByText('value'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show all columns' }));
    await waitFor(() => expect(screen.getByText('level')).toBeTruthy());
  });

  it('filters rows through the numeric range control', async () => {
    render(<MCAPSheet url="mem://test.mcap" dataLoader={loader} />);

    await screen.findByText('value');
    fireEvent.change(screen.getByLabelText('Min value') as HTMLInputElement, {
      target: { value: '2' },
    });

    await waitFor(() => expect(screen.getByText('1 / 2 rows')).toBeTruthy());
  });

  it('applies controlled filters and reports changes', async () => {
    const onFiltersChange = vi.fn();
    render(
      <MCAPSheet
        url="mem://test.mcap"
        dataLoader={loader}
        filters={{ value: { kind: 'number', min: '2', max: '' } }}
        onFiltersChange={onFiltersChange}
      />,
    );

    // Controlled filter is applied immediately (only value >= 2 remains).
    await waitFor(() => expect(screen.getByText('1 / 2 rows')).toBeTruthy());

    // Editing a filter reports out via onFiltersChange (controlled: parent owns state).
    fireEvent.change(screen.getByLabelText('Min value') as HTMLInputElement, {
      target: { value: '1' },
    });
    expect(onFiltersChange).toHaveBeenCalled();
  });

  it('paints an embedder cell highlight as the cell background', async () => {
    const { container } = render(
      <MCAPSheet
        url="mem://test.mcap"
        dataLoader={loader}
        highlights={{ cells: [{ rowIndex: 0, column: 'value', color: 'rgb(0, 128, 0)' }] }}
      />,
    );

    await screen.findByText('value');
    await waitFor(() => expect(cellAt(container, 0, 'value')).toBeTruthy());
    expect(cellAt(container, 0, 'value')!.style.background).toBe('rgb(0, 128, 0)');
    // A non-highlighted cell keeps the default background.
    expect(cellAt(container, 1, 'value')!.style.background).toBe('');
  });

  it('emits the user selection on click and shift-range', async () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <MCAPSheet url="mem://test.mcap" dataLoader={loader} selectable onSelectionChange={onSelectionChange} />,
    );

    await screen.findByText('value');
    await waitFor(() => expect(cellAt(container, 0, 'level')).toBeTruthy());

    fireEvent.mouseDown(cellAt(container, 0, 'level')!, { button: 0 });
    const last = (): MCAPSelection => onSelectionChange.mock.calls.at(-1)![0];
    expect(last().cells).toEqual([{ rowIndex: 0, column: 'level' }]);
    expect(cellAt(container, 0, 'level')!.className).toContain('is-selected');

    // Shift-click extends a rectangle: rows 0..1 × columns level..value = 4 cells.
    fireEvent.mouseDown(cellAt(container, 1, 'value')!, { button: 0, shiftKey: true });
    expect(last().cells).toHaveLength(4);
    expect(new Set(last().cells.map((c) => `${c.rowIndex}|${c.column}`))).toEqual(
      new Set(['0|level', '0|value', '1|level', '1|value']),
    );
  });

  it('selects a whole row from the cell context menu', async () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <MCAPSheet url="mem://test.mcap" dataLoader={loader} selectable onSelectionChange={onSelectionChange} />,
    );

    await screen.findByText('value');
    await waitFor(() => expect(cellAt(container, 0, 'level')).toBeTruthy());

    fireEvent.contextMenu(cellAt(container, 0, 'level')!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Select row' }));

    const last: MCAPSelection = onSelectionChange.mock.calls.at(-1)![0];
    expect(new Set(last.cells.map((c) => c.column))).toEqual(new Set([LOG_TIME_COLUMN, 'level', 'value']));
    expect(last.cells.every((c) => c.rowIndex === 0)).toBe(true);
  });
});
