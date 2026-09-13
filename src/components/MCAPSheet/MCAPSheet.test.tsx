// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MCAPSheet } from './MCAPSheet';
import { LOG_TIME_COLUMN } from '../../lib/mcap/worksheet';
import type { TopicWorksheet } from './types';

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

afterEach(cleanup);

describe('MCAPSheet', () => {
  it('renders a header for each column once the workbook loads', async () => {
    render(<MCAPSheet url="mem://test.mcap" dataLoader={loader} />);

    await waitFor(() => expect(screen.getByText(LOG_TIME_COLUMN)).toBeTruthy());
    expect(screen.getByText('level')).toBeTruthy();
    expect(screen.getByText('value')).toBeTruthy();
    // Toolbar reports the row count.
    expect(screen.getByText('2 / 2 rows')).toBeTruthy();
  });

  it('hides a column via the right-click menu and restores it', async () => {
    render(<MCAPSheet url="mem://test.mcap" dataLoader={loader} />);

    const levelHeader = await screen.findByText('level');
    fireEvent.contextMenu(levelHeader);

    const hideItem = await screen.findByRole('menuitem', { name: 'Hide "level"' });
    fireEvent.click(hideItem);

    await waitFor(() => expect(screen.queryByText('level')).toBeNull());

    // Re-open a menu from a remaining header and restore all columns.
    fireEvent.contextMenu(screen.getByText('value'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show all columns' }));

    await waitFor(() => expect(screen.getByText('level')).toBeTruthy());
  });

  it('filters rows through the numeric range control', async () => {
    render(<MCAPSheet url="mem://test.mcap" dataLoader={loader} />);

    await screen.findByText('value');
    const minInput = screen.getByLabelText('Min value') as HTMLInputElement;
    fireEvent.change(minInput, { target: { value: '2' } });

    await waitFor(() => expect(screen.getByText('1 / 2 rows')).toBeTruthy());
  });
});
