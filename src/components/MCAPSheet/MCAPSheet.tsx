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
import { buildColumnPredicate } from './columnFilterModel';
import { buildClipboardTable } from './clipboard';
import { cellKey, fromSelection, rectangleCells, toSelection, type CellRef } from './selectionModel';
import { cycleSort, sortRows, type SortSpec } from './sortModel';
import { CELL_FONT, HEADER_FONT, measureTextWidth } from './textWidth';
import type {
  CellValue,
  ColumnFilters,
  ColumnFilterValue,
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
  highlights,
  selectable = false,
  selection,
  onSelectionChange,
  filters,
  onFiltersChange,
  onTopicChange,
  sort,
  onSortChange,
}: MCAPSheetProps) {
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string>('');
  const [sheetCache, setSheetCache] = useState<Record<string, TopicWorksheet>>({});
  const [ranged, setRanged] = useState(false);
  const [filtersInternal, setFiltersInternal] = useState<ColumnFilters>({});
  const [sortInternal, setSortInternal] = useState<SortSpec | null>(null);
  const [selectionInternal, setSelectionInternal] = useState<Set<string>>(() => new Set());
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [menu, setMenu] = useState<{ x: number; y: number; columnId: string; rowIndex?: number } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [topicError, setTopicError] = useState<string | null>(null);

  const draggedColumnRef = useRef<string | null>(null);
  const sourceRef = useRef<McapWorkbookSource | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Selection interaction refs (read by document-level drag handlers).
  const anchorRef = useRef<CellRef | null>(null);
  const columnAnchorRef = useRef<string | null>(null);
  const baseRef = useRef<Set<string>>(new Set());
  const draggingRef = useRef(false);
  const rowDisplayOrderRef = useRef<number[]>([]);
  const visibleColumnsRef = useRef<string[]>([]);
  const commitSelectionRef = useRef<(next: Set<string>) => void>(() => {});
  const filtersControlledRef = useRef(false);
  const sortControlledRef = useRef(false);
  const selectionControlledRef = useRef(false);
  const onSelectionChangeRef = useRef<typeof onSelectionChange>(undefined);
  const onTopicChangeRef = useRef<typeof onTopicChange>(undefined);
  // Loaders are read from refs so passing an inline `dataLoader`/`workbookOpener`
  // (a fresh function each render) doesn't retrigger a full reload — the file is
  // only re-opened when `url` changes. The latest loader is always used at open
  // time. Refs are initialized to the first render's props (openSource may run
  // before the ref-sync effect below).
  const dataLoaderRef = useRef(dataLoader);
  const workbookOpenerRef = useRef(workbookOpener);

  // Resolve the workbook source: an eager `dataLoader` (tests/stories) wrapped
  // into a lazy source, an explicit `workbookOpener`, or the default lazy
  // range-aware opener.
  const openSource = useCallback(async (target: string): Promise<McapWorkbookSource> => {
    const loader = dataLoaderRef.current;
    if (loader) {
      const worksheets = await loader(target);
      const byTopic = new Map(worksheets.map((sheet) => [sheet.topic, sheet]));
      return {
        topics: worksheets.map((sheet) => ({
          topic: sheet.topic,
          messageCount: sheet.rows.length,
        })),
        ranged: false,
        loadTopic: async (topic) => byTopic.get(topic) ?? { topic, columns: [], rows: [] },
      };
    }

    const opener = workbookOpenerRef.current;
    if (opener) {
      return opener(target);
    }

    return openMcapWorkbook(target);
  }, []);

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

  // Stable identity: index into the UNFILTERED rows. Relies on filtering never
  // cloning row objects (see `filteredRows` below) — `row.original` is the same
  // object reference held here, so `row.id` is the original index.
  const rowIndexByRef = useMemo(() => {
    const map = new Map<Row, number>();
    if (selectedSheet) {
      selectedSheet.rows.forEach((row, index) => map.set(row, index));
    }
    return map;
  }, [selectedSheet]);

  // --- Controlled/uncontrolled filters ---
  const effectiveFilters = filters ?? filtersInternal;
  const commitFilters = useCallback(
    (next: ColumnFilters) => {
      if (filters === undefined) {
        setFiltersInternal(next);
      }
      onFiltersChange?.(next);
    },
    [filters, onFiltersChange],
  );
  const setColumnFilter = useCallback(
    (column: string, next: ColumnFilterValue | undefined) => {
      const current = filters ?? filtersInternal;
      if (!next) {
        if (!(column in current)) {
          return;
        }
        const { [column]: _removed, ...rest } = current;
        commitFilters(rest);
        return;
      }
      commitFilters({ ...current, [column]: next });
    },
    [filters, filtersInternal, commitFilters],
  );

  // --- Controlled/uncontrolled sort ---
  const effectiveSort = sort !== undefined ? sort : sortInternal;
  const commitSort = useCallback(
    (next: SortSpec | null) => {
      if (sort === undefined) {
        setSortInternal(next);
      }
      onSortChange?.(next);
    },
    [sort, onSortChange],
  );

  // --- Controlled/uncontrolled selection ---
  const effectiveSelectionSet = useMemo(
    () => (selection !== undefined ? fromSelection(selection) : selectionInternal),
    [selection, selectionInternal],
  );
  const commitSelection = useCallback(
    (next: Set<string>) => {
      if (selection === undefined) {
        setSelectionInternal(next);
      }
      onSelectionChange?.(toSelection(next));
    },
    [selection, onSelectionChange],
  );

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
        predicate: buildColumnPredicate(effectiveFilters[column], columnTypes[column]),
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
  }, [effectiveFilters, columnTypes, selectedSheet]);

  const sortedRows = useMemo(() => {
    if (!effectiveSort) {
      return filteredRows;
    }
    const numeric =
      columnTypes[effectiveSort.column]?.kind === 'number' ||
      TIMESTAMP_COLUMNS.includes(effectiveSort.column);
    return sortRows(filteredRows, effectiveSort, numeric);
  }, [filteredRows, effectiveSort, columnTypes]);

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
    data: sortedRows,
    columns,
    state: { columnOrder, columnVisibility, columnSizing },
    onColumnOrderChange: setColumnOrder,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getRowId: (row) => String(rowIndexByRef.get(row) ?? -1),
    getCoreRowModel: getCoreRowModel(),
    defaultColumn: { minSize: MIN_COLUMN_WIDTH, size: 150 },
  });

  const rows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // Order maps for range/column/row selection — computed from the models, so
  // they are correct even for rows/columns that aren't currently rendered.
  const rowDisplayOrder = useMemo(() => rows.map((row) => Number(row.id)), [rows]);
  // Visible columns in display order — mirrors TanStack's leaf order/visibility
  // (order is reset to the full column set on every sheet change).
  const visibleColumns = useMemo(() => {
    const order = columnOrder.length > 0 ? columnOrder : (selectedSheet?.columns ?? []);
    return order.filter((id) => columnVisibility[id] !== false);
  }, [columnOrder, columnVisibility, selectedSheet]);

  // Bounds-checked highlight lookup maps, ignored when scoped to another topic.
  const { rowHi, colHi, cellHi } = useMemo(() => {
    const rowHi = new Map<number, string>();
    const colHi = new Map<string, string>();
    const cellHi = new Map<string, string>();

    if (
      !selectedSheet ||
      !highlights ||
      (highlights.topic !== undefined && highlights.topic !== selectedTopic)
    ) {
      return { rowHi, colHi, cellHi };
    }

    const rowCount = selectedSheet.rows.length;
    const columnSet = new Set(selectedSheet.columns);
    const inRange = (rowIndex: number) => rowIndex >= 0 && rowIndex < rowCount;

    for (const { rowIndex, color } of highlights.rows ?? []) {
      if (inRange(rowIndex)) rowHi.set(rowIndex, color);
    }
    for (const { column, color } of highlights.columns ?? []) {
      if (columnSet.has(column)) colHi.set(column, color);
    }
    for (const { rowIndex, column, color } of highlights.cells ?? []) {
      if (inRange(rowIndex) && columnSet.has(column)) cellHi.set(cellKey(rowIndex, column), color);
    }

    return { rowHi, colHi, cellHi };
  }, [highlights, selectedSheet, selectedTopic]);

  // Reset view state (order/visibility/sizing) and auto-fit whenever the active
  // sheet changes. Filters reset only when uncontrolled (never clobber a
  // controlled embedder's filters).
  useEffect(() => {
    setColumnOrder(selectedSheet ? [...selectedSheet.columns] : []);
    setColumnVisibility({});
    if (!filtersControlledRef.current) {
      setFiltersInternal({});
    }
    if (!sortControlledRef.current) {
      setSortInternal(null);
    }

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

  // On topic change: clear selection (+ notify) and report the new topic. Keyed
  // on `selectedTopic` only (fires on tab click, before rows load); callbacks
  // are read from refs so a parent re-render doesn't re-trigger it.
  useEffect(() => {
    anchorRef.current = null;
    columnAnchorRef.current = null;
    baseRef.current = new Set();
    draggingRef.current = false;
    if (!selectionControlledRef.current) {
      setSelectionInternal(new Set());
    }
    onSelectionChangeRef.current?.({ cells: [] });
    if (selectedTopic) {
      onTopicChangeRef.current?.(selectedTopic);
    }
  }, [selectedTopic]);

  // Keep refs in sync with the latest render values for document-level handlers
  // and the (url-keyed) open effect.
  useEffect(() => {
    rowDisplayOrderRef.current = rowDisplayOrder;
    visibleColumnsRef.current = visibleColumns;
    commitSelectionRef.current = commitSelection;
    filtersControlledRef.current = filters !== undefined;
    sortControlledRef.current = sort !== undefined;
    selectionControlledRef.current = selection !== undefined;
    onSelectionChangeRef.current = onSelectionChange;
    onTopicChangeRef.current = onTopicChange;
    dataLoaderRef.current = dataLoader;
    workbookOpenerRef.current = workbookOpener;
  });

  // Rubber-band drag selection: extend the rectangle as the pointer moves over
  // cells, ending on mouse up. Attached once while `selectable`.
  useEffect(() => {
    if (!selectable) {
      return;
    }
    const onMove = (event: MouseEvent) => {
      if (!draggingRef.current || !anchorRef.current) {
        return;
      }
      const target = (event.target as HTMLElement | null)?.closest?.(
        '[data-row-id][data-col-id]',
      ) as HTMLElement | null;
      if (!target) {
        return;
      }
      const focus = { rowIndex: Number(target.dataset.rowId), column: target.dataset.colId ?? '' };
      const rect = rectangleCells(
        anchorRef.current,
        focus,
        rowDisplayOrderRef.current,
        visibleColumnsRef.current,
      );
      if (rect.length > 0) {
        commitSelectionRef.current(new Set(rect));
      }
    };
    const onUp = () => {
      draggingRef.current = false;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [selectable]);

  // Focus the grid so its `onCopy` handler receives Cmd/Ctrl+C.
  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true });

  const handleCellMouseDown = (
    event: React.MouseEvent,
    rowIndex: number,
    column: string,
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    focusGrid();
    columnAnchorRef.current = null;
    const key = cellKey(rowIndex, column);

    if (event.shiftKey && anchorRef.current) {
      const rect = rectangleCells(anchorRef.current, { rowIndex, column }, rowDisplayOrder, visibleColumns);
      if (rect.length > 0) {
        const next = new Set(baseRef.current);
        for (const cell of rect) next.add(cell);
        commitSelection(next);
        return;
      }
    }

    if (event.metaKey || event.ctrlKey) {
      const next = new Set(effectiveSelectionSet);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      baseRef.current = new Set(next);
      anchorRef.current = { rowIndex, column };
      commitSelection(next);
      return;
    }

    // Plain click: start a single selection that a drag can extend.
    baseRef.current = new Set();
    anchorRef.current = { rowIndex, column };
    draggingRef.current = true;
    commitSelection(new Set([key]));
  };

  // Click a column header to select the whole column (Cmd/Ctrl adds, Shift
  // selects a contiguous column range) — like clicking a column in Excel.
  const handleHeaderClick = (event: React.MouseEvent, column: string) => {
    if (!selectable) {
      return;
    }
    focusGrid();
    anchorRef.current = null;
    const cellsOf = (columns: string[]) =>
      columns.flatMap((col) => rows.map((row) => cellKey(Number(row.id), col)));

    if (event.shiftKey && columnAnchorRef.current) {
      const from = visibleColumns.indexOf(columnAnchorRef.current);
      const to = visibleColumns.indexOf(column);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        const next = new Set(baseRef.current);
        for (const key of cellsOf(visibleColumns.slice(lo, hi + 1))) next.add(key);
        commitSelection(next);
        return;
      }
    }

    columnAnchorRef.current = column;
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(effectiveSelectionSet);
      for (const key of cellsOf([column])) next.add(key);
      baseRef.current = new Set(next);
      commitSelection(next);
      return;
    }

    const next = new Set(cellsOf([column]));
    baseRef.current = new Set(next);
    commitSelection(next);
  };

  // Serialize the current selection to the clipboard as TSV (+ an HTML table)
  // so it pastes into Excel/Sheets with proper cell structure.
  const handleCopy = (event: React.ClipboardEvent) => {
    if (!selectedSheet) {
      return;
    }
    const table = buildClipboardTable(
      effectiveSelectionSet,
      rowDisplayOrder,
      visibleColumns,
      (rowIndex, column) => cellDisplayText(column, selectedSheet.rows[rowIndex][column]),
    );
    if (!table) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData('text/plain', table.text);
    event.clipboardData.setData('text/html', table.html);
  };

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

    const selectColumn = () => {
      commitSelection(new Set(rows.map((row) => cellKey(Number(row.id), menu.columnId))));
      anchorRef.current = null;
    };

    // Cell context menu (only when selectable): row/column/clear selection.
    if (menu.rowIndex !== undefined) {
      const rowIndex = menu.rowIndex;
      return [
        {
          label: 'Select row',
          onSelect: () => {
            commitSelection(new Set(visibleColumns.map((column) => cellKey(rowIndex, column))));
            anchorRef.current = null;
          },
        },
        { label: `Select column "${menu.columnId}"`, onSelect: selectColumn },
        {
          label: 'Clear selection',
          disabled: effectiveSelectionSet.size === 0,
          onSelect: () => {
            commitSelection(new Set());
            anchorRef.current = null;
          },
        },
      ];
    }

    // Column header menu: sort, hide/show columns, plus select-column.
    const leafColumns = table.getAllLeafColumns();
    const hidden = leafColumns.filter((column) => !column.getIsVisible());
    const visibleCount = leafColumns.length - hidden.length;
    const sortedByThis = effectiveSort?.column === menu.columnId;

    const items: ContextMenuItem[] = [
      {
        label: 'Sort ascending',
        onSelect: () => commitSort({ column: menu.columnId, direction: 'asc' }),
      },
      {
        label: 'Sort descending',
        onSelect: () => commitSort({ column: menu.columnId, direction: 'desc' }),
      },
      {
        label: 'Clear sort',
        disabled: !sortedByThis,
        onSelect: () => commitSort(null),
      },
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

    if (selectable) {
      items.push({ label: `Select column "${menu.columnId}"`, onSelect: selectColumn });
    }

    return items;
  }, [
    menu,
    table,
    selectable,
    rows,
    visibleColumns,
    effectiveSelectionSet,
    commitSelection,
    effectiveSort,
    commitSort,
  ]);

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const totalWidth = table.getTotalSize();
  const virtualRows = rowVirtualizer.getVirtualItems();

  const showGrid = !loading && !error && selectedSheet;
  const showTopicStatus = !loading && !error && selectedTopic && !selectedSheet;

  return (
    <section className={`mcap-sheet ${fill ? 'mcap-sheet--fill' : ''} ${className ?? ''}`.trim()}>
      <header className="mcap-sheet__toolbar">
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
          className={`mcap-sheet__table-wrap mcap-grid ${selectable ? 'mcap-grid--selectable' : ''}`.trim()}
          style={fill ? undefined : { height }}
          ref={scrollRef}
          tabIndex={selectable ? 0 : undefined}
          onCopy={selectable ? handleCopy : undefined}
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
                        onClick={selectable ? (event) => handleHeaderClick(event, columnId) : undefined}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setMenu({ x: event.clientX, y: event.clientY, columnId });
                        }}
                      >
                        {columnId}
                      </span>
                      <button
                        type="button"
                        className={`mcap-grid__sort ${effectiveSort?.column === columnId ? 'is-active' : ''}`.trim()}
                        aria-label={`Sort ${columnId}`}
                        title="Sort"
                        onClick={(event) => {
                          event.stopPropagation();
                          commitSort(cycleSort(effectiveSort, columnId));
                        }}
                      >
                        {effectiveSort?.column === columnId
                          ? effectiveSort.direction === 'asc'
                            ? '▲'
                            : '▼'
                          : '⇅'}
                      </button>
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
                        value={effectiveFilters[columnId]}
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
                const rowIndex = Number(row.id);
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
                      const key = cellKey(rowIndex, columnId);
                      const background = cellHi.get(key) ?? rowHi.get(rowIndex) ?? colHi.get(columnId);
                      const width = cell.column.getSize();
                      return (
                        <div
                          key={cell.id}
                          className={`mcap-grid__td ${effectiveSelectionSet.has(key) ? 'is-selected' : ''}`.trim()}
                          style={background ? { width, background } : { width }}
                          title={isTimestamp ? raw : text}
                          data-row-id={rowIndex}
                          data-col-id={columnId}
                          onMouseDown={
                            selectable ? (event) => handleCellMouseDown(event, rowIndex, columnId) : undefined
                          }
                          onContextMenu={
                            selectable
                              ? (event) => {
                                  event.preventDefault();
                                  setMenu({ x: event.clientX, y: event.clientY, columnId, rowIndex });
                                }
                              : undefined
                          }
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
        <ColumnContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
    </section>
  );
}
