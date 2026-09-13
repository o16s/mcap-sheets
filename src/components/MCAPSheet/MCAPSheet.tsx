import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type ColumnSizingState,
  type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { openMcapWorkbook } from '../../lib/mcap/mcapWorkbook';
import { formatTimestamp, TIMESTAMP_COLUMNS } from '../../lib/mcap/worksheet';
import { inferColumnType, type ColumnType } from '../../lib/mcap/columnTypes';
import { ColumnFilter } from './ColumnFilter';
import { ColumnContextMenu, type ContextMenuItem } from './ColumnContextMenu';
import { buildColumnPredicate, type ColumnFilterValue } from './columnFilterModel';
import { CELL_FONT, HEADER_FONT, measureTextWidth } from './textWidth';
import type {
  CellValue,
  McapWorkbookSource,
  MCAPSheetProps,
  TopicSummary,
  TopicWorksheet,
} from './types';
import './MCAPSheet.css';

type Row = Record<string, CellValue>;

const toCellText = (value: CellValue): string => (value === null ? '' : String(value));

// Rows scanned when autosizing a column; caps the cost on very large sheets
// while covering enough data to fit typical content.
const AUTOSIZE_SAMPLE = 2000;
// Extra pixels added to measured text: cell horizontal padding + resize grip.
const AUTOSIZE_PADDING = 30;
const MIN_COLUMN_WIDTH = 56;
// Upper bound so one very long value can't blow out a column on auto-fit.
const MAX_AUTOSIZE_WIDTH = 480;

const cellDisplayText = (column: string, value: CellValue): string =>
  TIMESTAMP_COLUMNS.includes(column) ? formatTimestamp(value) : toCellText(value);

/**
 * Measures the width needed to fit a column's header and (a sample of) its cell
 * content, clamped to sane bounds. Used both for double-click autosize and for
 * the initial auto-fit on load.
 */
const computeColumnWidth = (columnId: string, rows: Row[]): number => {
  let widest = measureTextWidth(columnId, HEADER_FONT);
  const limit = Math.min(rows.length, AUTOSIZE_SAMPLE);
  for (let index = 0; index < limit; index += 1) {
    const width = measureTextWidth(cellDisplayText(columnId, rows[index][columnId]), CELL_FONT);
    if (width > widest) {
      widest = width;
    }
  }

  return Math.min(MAX_AUTOSIZE_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.ceil(widest) + AUTOSIZE_PADDING));
};

export function MCAPSheet({
  url,
  className,
  height = 560,
  fill = false,
  rowHeight = 36,
  dataLoader,
  workbookOpener,
}: MCAPSheetProps) {
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string>('');
  const [sheetCache, setSheetCache] = useState<Record<string, TopicWorksheet>>({});
  const [ranged, setRanged] = useState(false);
  const [columnFilters, setColumnFilters] = useState<Record<string, ColumnFilterValue>>({});
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [menu, setMenu] = useState<{ x: number; y: number; columnId: string } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const draggedColumnRef = useRef<string | null>(null);
  const sourceRef = useRef<McapWorkbookSource | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [topicError, setTopicError] = useState<string | null>(null);

  // Resolve the workbook source: an eager `dataLoader` (tests/stories) wrapped
  // into a lazy source, an explicit `workbookOpener`, or the default lazy
  // range-aware opener.
  const openSource = useCallback(
    async (target: string): Promise<McapWorkbookSource> => {
      if (dataLoader) {
        const worksheets = await dataLoader(target);
        const byTopic = new Map(worksheets.map((sheet) => [sheet.topic, sheet]));
        return {
          topics: worksheets.map((sheet) => ({
            topic: sheet.topic,
            messageCount: sheet.rows.length,
          })),
          ranged: false,
          loadTopic: async (topic) =>
            byTopic.get(topic) ?? { topic, columns: [], rows: [] },
        };
      }

      if (workbookOpener) {
        return workbookOpener(target);
      }

      return openMcapWorkbook(target);
    },
    [dataLoader, workbookOpener],
  );

  // Open the workbook whenever the URL changes: read the summary, list topics,
  // and select the first one.
  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);
    setTopicError(null);
    sourceRef.current = null;
    setTopics([]);
    setSheetCache({});
    setSelectedTopic('');

    openSource(url)
      .then((source) => {
        if (cancelled) {
          return;
        }
        sourceRef.current = source;
        setTopics(source.topics);
        setRanged(source.ranged);
        setSelectedTopic(source.topics[0]?.topic ?? '');
      })
      .catch((openError) => {
        if (cancelled) {
          return;
        }
        setError(openError instanceof Error ? openError.message : 'Unable to open MCAP file');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url, openSource]);

  // Lazily load the selected topic's rows on demand, caching the result.
  useEffect(() => {
    const source = sourceRef.current;
    if (!source || !selectedTopic || sheetCache[selectedTopic]) {
      return;
    }

    let cancelled = false;
    setTopicError(null);

    source
      .loadTopic(selectedTopic)
      .then((sheet) => {
        if (cancelled) {
          return;
        }
        setSheetCache((current) => ({ ...current, [selectedTopic]: sheet }));
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setTopicError(loadError instanceof Error ? loadError.message : 'Unable to load topic');
      });

    return () => {
      cancelled = true;
    };
  }, [selectedTopic, sheetCache]);

  const selectedSheet = sheetCache[selectedTopic];

  // Reset all column state whenever the active sheet (and therefore its column
  // set) changes, and auto-fit each column to its content.
  useEffect(() => {
    setColumnOrder(selectedSheet ? [...selectedSheet.columns] : []);
    setColumnVisibility({});
    setColumnFilters({});

    if (!selectedSheet) {
      setColumnSizing({});
      return;
    }

    const sizing: ColumnSizingState = {};
    for (const column of selectedSheet.columns) {
      sizing[column] = computeColumnWidth(column, selectedSheet.rows);
    }
    setColumnSizing(sizing);
  }, [selectedSheet]);

  const columnTypes = useMemo(() => {
    const types: Record<string, ColumnType> = {};
    if (!selectedSheet) {
      return types;
    }

    for (const column of selectedSheet.columns) {
      types[column] = inferColumnType(
        (function* iterate() {
          for (const row of selectedSheet.rows) {
            yield row[column];
          }
        })(),
      );
    }

    return types;
  }, [selectedSheet]);

  const filteredRows = useMemo(() => {
    if (!selectedSheet) {
      return [];
    }

    const predicates = selectedSheet.columns
      .map((column) => ({
        column,
        predicate: buildColumnPredicate(columnFilters[column], columnTypes[column]),
      }))
      .filter((entry): entry is { column: string; predicate: (value: CellValue) => boolean } =>
        entry.predicate !== null,
      );

    if (predicates.length === 0) {
      return selectedSheet.rows;
    }

    return selectedSheet.rows.filter((row) =>
      predicates.every(({ column, predicate }) => predicate(row[column])),
    );
  }, [columnFilters, columnTypes, selectedSheet]);

  const columns = useMemo<ColumnDef<Row>[]>(() => {
    if (!selectedSheet) {
      return [];
    }

    return selectedSheet.columns.map((column) => ({
      id: column,
      accessorFn: (row) => row[column],
    }));
  }, [selectedSheet]);

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: { columnOrder, columnVisibility, columnSizing },
    onColumnOrderChange: setColumnOrder,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    defaultColumn: { minSize: MIN_COLUMN_WIDTH, size: 150 },
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  const setColumnFilter = useCallback((column: string, next: ColumnFilterValue | undefined) => {
    setColumnFilters((current) => {
      if (!next) {
        if (!(column in current)) {
          return current;
        }
        const { [column]: _removed, ...rest } = current;
        return rest;
      }

      return { ...current, [column]: next };
    });
  }, []);

  const autoSizeColumn = useCallback(
    (columnId: string) => {
      setColumnSizing((current) => ({
        ...current,
        [columnId]: computeColumnWidth(columnId, filteredRows),
      }));
    },
    [filteredRows],
  );

  const reorderColumn = useCallback(
    (targetId: string) => {
      const draggedId = draggedColumnRef.current;
      draggedColumnRef.current = null;
      setDragOverId(null);
      if (!draggedId || draggedId === targetId) {
        return;
      }

      setColumnOrder((current) => {
        const order = current.length
          ? [...current]
          : table.getAllLeafColumns().map((leaf) => leaf.id);
        const from = order.indexOf(draggedId);
        const to = order.indexOf(targetId);
        if (from === -1 || to === -1) {
          return current;
        }
        const [moved] = order.splice(from, 1);
        order.splice(to, 0, moved);
        return order;
      });
    },
    [table],
  );

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) {
      return [];
    }

    const leafColumns = table.getAllLeafColumns();
    const hidden = leafColumns.filter((column) => !column.getIsVisible());
    const visibleCount = leafColumns.length - hidden.length;

    const items: ContextMenuItem[] = [
      {
        label: `Hide "${menu.columnId}"`,
        disabled: visibleCount <= 1,
        onSelect: () =>
          setColumnVisibility((current) => ({ ...current, [menu.columnId]: false })),
      },
    ];

    for (const column of hidden) {
      items.push({
        label: `Show "${column.id}"`,
        onSelect: () =>
          setColumnVisibility((current) => {
            const next = { ...current };
            delete next[column.id];
            return next;
          }),
      });
    }

    items.push({
      label: 'Show all columns',
      disabled: hidden.length === 0,
      onSelect: () => setColumnVisibility({}),
    });

    return items;
  }, [menu, table]);

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const totalWidth = table.getTotalSize();
  const virtualRows = rowVirtualizer.getVirtualItems();

  const showGrid = !loading && !error && selectedSheet;
  const showTopicStatus = !loading && !error && selectedTopic && !selectedSheet;

  return (
    <section className={`mcap-sheet ${fill ? 'mcap-sheet--fill' : ''} ${className ?? ''}`.trim()}>
      <header className="mcap-sheet__toolbar">
        <span className="mcap-sheet__source" title={url}>
          {url}
        </span>
        <span className="mcap-sheet__meta">
          {ranged ? (
            <span className="mcap-sheet__badge" title="Reading via HTTP range requests">
              range
            </span>
          ) : null}
          {selectedSheet ? (
            <span>
              {filteredRows.length} / {selectedSheet.rows.length} rows
            </span>
          ) : null}
        </span>
      </header>

      {loading ? <p className="mcap-sheet__status">Loading MCAP file…</p> : null}
      {error ? <p className="mcap-sheet__status mcap-sheet__status--error">{error}</p> : null}
      {!loading && !error && topics.length === 0 ? (
        <p className="mcap-sheet__status">No messages were found in this MCAP file.</p>
      ) : null}
      {showTopicStatus ? (
        topicError ? (
          <p className="mcap-sheet__status mcap-sheet__status--error">{topicError}</p>
        ) : (
          <p className="mcap-sheet__status">Loading “{selectedTopic}”…</p>
        )
      ) : null}

      {showGrid ? (
        <div
          className="mcap-sheet__table-wrap mcap-grid"
          style={fill ? undefined : { height }}
          ref={scrollRef}
        >
          <div className="mcap-grid__inner" style={{ width: totalWidth }}>
            <div className="mcap-grid__thead">
              <div className="mcap-grid__header-row" role="row">
                {headers.map((header) => {
                  const columnId = header.column.id;
                  return (
                    <div
                      key={header.id}
                      className={`mcap-grid__th ${dragOverId === columnId ? 'is-drop-target' : ''}`.trim()}
                      style={{ width: header.getSize() }}
                    >
                      <span
                        className="mcap-grid__th-label"
                        title={columnId}
                        draggable
                        onDragStart={(event) => {
                          draggedColumnRef.current = columnId;
                          event.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => {
                          draggedColumnRef.current = null;
                          setDragOverId(null);
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          if (dragOverId !== columnId) {
                            setDragOverId(columnId);
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          reorderColumn(columnId);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setMenu({ x: event.clientX, y: event.clientY, columnId });
                        }}
                      >
                        {columnId}
                      </span>
                      <div
                        className={`mcap-grid__resizer ${header.column.getIsResizing() ? 'is-resizing' : ''}`.trim()}
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        onDoubleClick={() => autoSizeColumn(columnId)}
                        title="Drag to resize · double-click to fit"
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mcap-grid__filter-row" role="row">
                {headers.map((header) => {
                  const columnId = header.column.id;
                  return (
                    <div
                      key={`${header.id}__filter`}
                      className="mcap-grid__filter-cell"
                      style={{ width: header.getSize() }}
                    >
                      <ColumnFilter
                        column={columnId}
                        type={columnTypes[columnId] ?? { kind: 'text' }}
                        value={columnFilters[columnId]}
                        onChange={(next) => setColumnFilter(columnId, next)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mcap-grid__tbody" style={{ height: rowVirtualizer.getTotalSize() }}>
              {virtualRows.map((virtualRow) => {
                const row = rows[virtualRow.index];
                return (
                  <div
                    key={row.id}
                    className="mcap-grid__tr"
                    style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                    role="row"
                  >
                    {row.getVisibleCells().map((cell) => {
                      const columnId = cell.column.id;
                      const value = row.original[columnId];
                      const isTimestamp = TIMESTAMP_COLUMNS.includes(columnId);
                      const raw = toCellText(value);
                      const text = isTimestamp ? formatTimestamp(value) : raw;
                      return (
                        <div
                          key={cell.id}
                          className="mcap-grid__td"
                          style={{ width: cell.column.getSize() }}
                          title={isTimestamp ? raw : text}
                        >
                          {text}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {topics.length > 0 ? (
        <nav className="mcap-sheet__tabs" aria-label="MCAP topics">
          {topics.map((topic) => (
            <button
              key={topic.topic}
              type="button"
              className={`mcap-sheet__tab ${topic.topic === selectedTopic ? 'is-active' : ''}`}
              onClick={() => setSelectedTopic(topic.topic)}
            >
              {topic.topic}
              {topic.messageCount !== undefined ? (
                <span className="mcap-sheet__tab-count">{topic.messageCount}</span>
              ) : null}
            </button>
          ))}
        </nav>
      ) : null}

      {menu ? (
        <ColumnContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </section>
  );
}
