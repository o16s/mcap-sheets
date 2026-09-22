import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { MCAPSheet } from './MCAPSheet';
import { LOG_TIME_COLUMN } from '../../lib/mcap/worksheet';
import type {
  ColumnFilters,
  MCAPHighlights,
  MCAPSelection,
  SortSpec,
  TopicRows,
} from './types';

const sampleWorkbook: TopicRows[] = [
  {
    topic: '/imu',
    columns: [LOG_TIME_COLUMN, 'header.frame_id', 'linear_acceleration.x', 'linear_acceleration.y'],
    rows: [
      {
        [LOG_TIME_COLUMN]: '1000000000',
        'header.frame_id': 'imu_link_front',
        'linear_acceleration.x': 0.3,
        'linear_acceleration.y': -0.1,
      },
      {
        [LOG_TIME_COLUMN]: '2000000000',
        'header.frame_id': 'imu_link_rear',
        'linear_acceleration.x': 0.2,
        'linear_acceleration.y': -0.2,
      },
    ],
  },
  {
    topic: '/gps',
    columns: [LOG_TIME_COLUMN, 'fix.latitude', 'fix.longitude'],
    rows: [
      {
        [LOG_TIME_COLUMN]: '3000000000',
        'fix.latitude': 37.789,
        'fix.longitude': -122.401,
      },
    ],
  },
];

const meta = {
  component: MCAPSheet,
  args: {
    url: 'https://example.com/sample.mcap',
    dataLoader: async () => sampleWorkbook,
    height: 420,
  },
  tags: ['ai-generated'],
} satisfies Meta<typeof MCAPSheet>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithColumnFilter: Story = {
  play: async ({ canvas, userEvent }) => {
    // linear_acceleration.x is numeric, so it gets a min/max range filter.
    const minInput = await canvas.findByLabelText('Min linear_acceleration.x');
    await userEvent.type(minInput, '0.25');
    await expect(canvas.getByText('imu_link_front')).toBeVisible();
    await expect(canvas.queryByText('imu_link_rear')).toBeNull();
  },
};

export const CssCheck: Story = {
  play: async ({ canvas }) => {
    const tab = await canvas.findByRole('button', { name: /\/imu/ });
    await expect(getComputedStyle(tab).backgroundColor).toBe('rgb(255, 255, 255)');
  },
};

// --- Two-way communication demo -------------------------------------------

// Enum filters use a Set; serialize it so the readout can render as JSON.
const serializeFilters = (filters: ColumnFilters) =>
  Object.fromEntries(
    Object.entries(filters).map(([column, filter]) => [
      column,
      filter.kind === 'enum' ? { kind: 'enum', selected: [...filter.selected] } : filter,
    ]),
  );

const panelBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 8px',
  marginBottom: 6,
  border: '1px solid #d1d5db',
  borderRadius: 6,
  background: '#fff',
  font: 'inherit',
  cursor: 'pointer',
};

function TwoWayDemo() {
  const [topic, setTopic] = useState('/imu');
  const [color, setColor] = useState('#ffe08a');
  const [highlights, setHighlights] = useState<MCAPHighlights>({ topic: '/imu' });
  const [filters, setFilters] = useState<ColumnFilters>({});
  const [selection, setSelection] = useState<MCAPSelection>({ cells: [] });
  const [sort, setSort] = useState<SortSpec | null>(null);

  const hasSelection = selection.cells.length > 0;
  const distinctColumns = [...new Set(selection.cells.map((cell) => cell.column))];
  const distinctRows = [...new Set(selection.cells.map((cell) => cell.rowIndex))];

  return (
    <div style={{ display: 'flex', gap: 16, height: 460, font: '13px Inter, system-ui, sans-serif' }}>
      <div style={{ flex: 1, minWidth: 0, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        <MCAPSheet
          fill
          url="demo://sample.mcap"
          dataLoader={() => Promise.resolve(sampleWorkbook)}
          selectable
          highlights={highlights}
          filters={filters}
          onFiltersChange={setFilters}
          sort={sort}
          onSortChange={setSort}
          selection={selection}
          onSelectionChange={setSelection}
          onTopicChange={(next) => {
            setTopic(next);
            // Highlights are per-topic — scope them and clear on switch.
            setHighlights({ topic: next });
            setFilters({});
            setSort(null);
          }}
        />
      </div>

      <aside style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <section>
          <strong>Write → component</strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
            <input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="Highlight color" />
            <span>highlight color</span>
          </div>
          <button
            type="button"
            style={panelBtn}
            disabled={!hasSelection}
            onClick={() =>
              setHighlights((current) => ({
                ...current,
                topic,
                cells: [
                  ...(current.cells ?? []),
                  ...selection.cells.map((cell) => ({ ...cell, color })),
                ],
              }))
            }
          >
            Highlight selected cells
          </button>
          <button
            type="button"
            style={panelBtn}
            disabled={!hasSelection}
            onClick={() =>
              setHighlights((current) => ({
                ...current,
                topic,
                columns: [
                  ...(current.columns ?? []),
                  ...distinctColumns.map((column) => ({ column, color })),
                ],
              }))
            }
          >
            Highlight selected columns
          </button>
          <button
            type="button"
            style={panelBtn}
            disabled={!hasSelection}
            onClick={() =>
              setHighlights((current) => ({
                ...current,
                topic,
                rows: [...(current.rows ?? []), ...distinctRows.map((rowIndex) => ({ rowIndex, color }))],
              }))
            }
          >
            Highlight selected rows
          </button>
          <button type="button" style={panelBtn} onClick={() => setHighlights({ topic })}>
            Clear highlights
          </button>
          <button
            type="button"
            style={panelBtn}
            onClick={() =>
              setFilters(
                topic === '/imu'
                  ? { 'header.frame_id': { kind: 'text', query: 'front' } }
                  : { 'fix.latitude': { kind: 'number', min: '37.5', max: '' } },
              )
            }
          >
            Set filter from outside
          </button>
          <button type="button" style={panelBtn} onClick={() => setFilters({})}>
            Clear filters
          </button>
          <button
            type="button"
            style={panelBtn}
            onClick={() => setSort({ column: LOG_TIME_COLUMN, direction: 'desc' })}
          >
            Sort by {LOG_TIME_COLUMN} ↓ from outside
          </button>
        </section>

        <section style={{ borderTop: '1px solid #e5e7eb', paddingTop: 10 }}>
          <strong>Read ← component</strong>
          <p style={{ margin: '6px 0' }}>
            Topic: <code>{topic}</code>
          </p>
          <p style={{ margin: '6px 0' }}>
            Sort: <code>{sort ? `${sort.column} ${sort.direction}` : '(none)'}</code>
          </p>
          <p style={{ margin: '6px 0', color: '#6b7280' }}>
            Tip: click a column header to select it, drag or Shift-click to select a range, then
            press ⌘/Ctrl+C to copy into Excel.
          </p>
          <p style={{ margin: '6px 0' }}>Selection ({selection.cells.length} cells):</p>
          <pre style={{ margin: 0, maxHeight: 120, overflow: 'auto', background: '#f8fafc', padding: 8, borderRadius: 6 }}>
            {selection.cells.map((cell) => `r${cell.rowIndex} · ${cell.column}`).join('\n') || '(none)'}
          </pre>
          <p style={{ margin: '10px 0 6px' }}>Filters:</p>
          <pre style={{ margin: 0, maxHeight: 120, overflow: 'auto', background: '#f8fafc', padding: 8, borderRadius: 6 }}>
            {JSON.stringify(serializeFilters(filters), null, 2)}
          </pre>
        </section>
      </aside>
    </div>
  );
}

export const TwoWayComm: Story = {
  name: 'Two-way communication',
  render: () => <TwoWayDemo />,
};
