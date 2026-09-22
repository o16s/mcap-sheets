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
import {
  cellAt,
  openMcapWorkbook,
  worksheetFromRows,
  type LoadProgress,
} from '../../lib/mcap/mcapWorkbook';
import { formatTimestamp, TIMESTAMP_COLUMNS } from '../../lib/mcap/worksheet';
import { inferColumnType, type ColumnType } from '../../lib/mcap/columnTypes';
import { ColumnFilter } from './ColumnFilter';
import { ColumnContextMenu, type ContextMenuItem } from './ColumnContextMenu';
import { buildColumnPredicate } from './columnFilterModel';
import { buildClipboardTable } from './clipboard';
import { cellKey, fromSelection, rectangleCells, toSelection, type CellRef } from './selectionModel';
import { cycleSort, sortRowIndices, type SortSpec } from './sortModel';
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

// The table's row datum is the row's index into the topic's UNFILTERED rows.
// Cell values are read column-major from the worksheet, so we never materialize
// per-row objects (critical for very wide schemas).
type RowIndex = number;

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
const computeColumnWidth = (
  columnId: string,
  sheet: TopicWorksheet,
  sampleIndices: number[],
): number => {
  let widest = measureTextWidth(columnId, HEADER_FONT);
  const cells = sheet.columnData.get(columnId);
  const limit = Math.min(sampleIndices.length, AUTOSIZE_SAMPLE);
  for (let index = 0; index < limit; index += 1) {
    const value = cells?.[sampleIndices[index]] ?? null;
    const width = measureTextWidth(cellDisplayText(columnId, value), CELL_FONT);
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
  onRowsLoaded,
  scrollToRowIndex,
}: MCAPSheetProps) {
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string>('');
  // Final (fully-decoded) sheets, keyed by topic.
  const [sheetCache, setSheetCache] = useState<Record<string, TopicWorksheet>>({});
  // The current in-progress topic's latest partial snapshot (progressive paint).
  const [partial, setPartial] = useState<{ topic: string; sheet: TopicWorksheet } | null>(null);
  // The topic currently mid-stream (null once its final sheet lands).
  const [streamingTopic, setStreamingTopic] = useState<string | null>(null);
  const [ranged, setRanged] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
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
  // Topics whose load has been kicked off (so partial updates don't restart it).
  const loadStartedRef = useRef<Set<string>>(new Set());
  // `${topic}:${columnCount}` last auto-sized — so we size once per topic (and
  // again only if the column set grows mid-stream), not on every partial.
  const sizedKeyRef = useRef<string>('');
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
  const onRowsLoadedRef = useRef<typeof onRowsLoaded>(undefined);
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
      const byTopic = new Map(worksheets.map((sheet) => [sheet.topic, worksheetFromRows(sheet)]));
      return {
        topics: worksheets.map((sheet) => ({
          topic: sheet.topic,
          messageCount: sheet.rows.length,
        })),
        ranged: false,
        loadTopic: async (topic) =>
          byTopic.get(topic) ?? { topic, columns: [], rowCount: 0, columnData: new Map() },
      };
    }

    const opener = workbookOpenerRef.current;
    if (opener) {
      return opener(target);
    }

    return openMcapWorkbook(target, { onProgress: setProgress });
  }, []);

  // Open the workbook whenever the URL changes: read the summary, list topics,
  // and select the first one.
  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);
    setTopicError(null);
    setProgress(null);
    setRecovered(false);
    sourceRef.current = null;
    loadStartedRef.current = new Set();
    sizedKeyRef.current = '';
    setTopics([]);
    setSheetCache({});
    setPartial(null);
    setStreamingTopic(null);
    setSelectedTopic('');

    openSource(url)
      .then((source) => {
        if (cancelled) {
          return;
        }
        sourceRef.current = source;
        setTopics(source.topics);
        setRanged(source.ranged);
        setRecovered(source.recovered ?? false);
        setProgress(null);
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

  // Lazily load the selected topic on demand. The streaming source emits partial
  // snapshots as rows decode, so the grid paints the first rows almost
  // immediately and grows live; the promise resolves with the final sheet.
  // Keyed on `selectedTopic` only (partials must not restart the load), guarded
  // by a ref so a topic loads at most once.
  useEffect(() => {
    const source = sourceRef.current;
    if (!source || !selectedTopic) {
      return;
    }
    if (sheetCache[selectedTopic] || loadStartedRef.current.has(selectedTopic)) {
      return;
    }
    loadStartedRef.current.add(selectedTopic);

    let cancelled = false;
    setTopicError(null);
    setStreamingTopic(selectedTopic);

    source
      .loadTopic(selectedTopic, (snapshot) => {
        if (!cancelled) {
          setPartial({ topic: selectedTopic, sheet: snapshot });
        }
      })
      .then((sheet) => {
        if (cancelled) {
          return;
        }
        setSheetCache((current) => ({ ...current, [selectedTopic]: sheet }));
        setPartial((current) => (current?.topic === selectedTopic ? null : current));
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        loadStartedRef.current.delete(selectedTopic); // allow a retry
        setTopicError(loadError instanceof Error ? loadError.message : 'Unable to load topic');
      })
      .finally(() => {
        if (!cancelled) {
          setStreamingTopic((current) => (current === selectedTopic ? null : current));
          setProgress(null);
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTopic]);

  // The sheet to display: the final one if loaded, else the latest partial.
  const selectedSheet =
    sheetCache[selectedTopic] ??
    (partial?.topic === selectedTopic ? partial.sheet : undefined);
  // Whether the displayed sheet is fully decoded (gates filter/sort/type work).
  const ready = Boolean(sheetCache[selectedTopic]);
  // Whether we're still streaming rows into the current topic.
  const streaming = streamingTopic === selectedTopic && !ready;

  // Every unfiltered row index [0, rowCount). This is the base the table's data
  // (a filtered/sorted permutation of indices) is derived from; a row's identity
  // is simply its index.
  const allIndices = useMemo(
    () => (selectedSheet ? Array.from({ length: selectedSheet.rowCount }, (_, i) => i) : []),
    [selectedSheet],
  );

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
    // Defer type inference (enum/number detection scans every row) until the
    // topic is fully loaded — during streaming we just paint rows.
    if (!selectedSheet || !ready) {
      return types;
    }

    for (const column of selectedSheet.columns) {
      const cells = selectedSheet.columnData.get(column) ?? [];
      types[column] = inferColumnType(
        (function* iterate() {
          for (let index = 0; index < selectedSheet.rowCount; index += 1) {
            yield cells[index] ?? null;
          }
        })(),
      );
    }

    return types;
  }, [selectedSheet, ready]);

  const filteredIndices = useMemo(() => {
    if (!selectedSheet) {
      return [];
    }
    // While streaming, show every row in natural order (no filtering) so paint
    // stays cheap and immediate; filters apply once fully loaded.
    if (!ready) {
      return allIndices;
    }

    // Hoist each active column's cell array so the hot filter loop indexes an
    // array directly instead of going through a Map per cell.
    const predicates = selectedSheet.columns
      .map((column) => ({
        cells: selectedSheet.columnData.get(column),
        predicate: buildColumnPredicate(effectiveFilters[column], columnTypes[column]),
      }))
      .filter(
        (entry): entry is { cells: CellValue[] | undefined; predicate: (value: CellValue) => boolean } =>
          entry.predicate !== null,
      );

    if (predicates.length === 0) {
      return allIndices;
    }

    return allIndices.filter((rowIndex) =>
      predicates.every(({ cells, predicate }) => predicate(cells?.[rowIndex] ?? null)),
    );
  }, [effectiveFilters, columnTypes, selectedSheet, allIndices, ready]);

  const sortedIndices = useMemo(() => {
    // No sorting while streaming (re-sorting a growing set each snapshot would
    // stutter); apply once fully loaded.
    if (!ready || !effectiveSort || !selectedSheet) {
      return filteredIndices;
    }
    const numeric =
      columnTypes[effectiveSort.column]?.kind === 'number' ||
      TIMESTAMP_COLUMNS.includes(effectiveSort.column);
    const cells = selectedSheet.columnData.get(effectiveSort.column);
    return sortRowIndices(
      filteredIndices,
      effectiveSort,
      numeric,
      (rowIndex) => cells?.[rowIndex] ?? null,
    );
  }, [filteredIndices, effectiveSort, columnTypes, selectedSheet, ready]);

  const columns = useMemo<ColumnDef<RowIndex>[]>(() => {
    if (!selectedSheet) {
      return [];
    }

    return selectedSheet.columns.map((column) => {
      const cells = selectedSheet.columnData.get(column);
      return {
        id: column,
        accessorFn: (rowIndex) => cells?.[rowIndex] ?? null,
      };
    });
  }, [selectedSheet]);

  const table = useReactTable({
    data: sortedIndices,
    columns,
    state: { columnOrder, columnVisibility, columnSizing },
    onColumnOrderChange: setColumnOrder,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getRowId: (rowIndex) => String(rowIndex),
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

    const rowCount = selectedSheet.rowCount;
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

  // On topic switch, reset view state (order/visibility/sizing). Filters/sort
  // reset only when uncontrolled (never clobber a controlled embedder's state).
  // Keyed on `selectedTopic` so progressive partials don't wipe the user's view.
  useEffect(() => {
    setColumnOrder([]);
    setColumnVisibility({});
    setColumnSizing({});
    sizedKeyRef.current = '';
    if (!filtersControlledRef.current) {
      setFiltersInternal({});
    }
    if (!sortControlledRef.current) {
      setSortInternal(null);
    }
  }, [selectedTopic]);

  // Establish column order + auto-fit widths once the columns are first known
  // (from the first partial), and again only if the column set grows mid-stream.
  // Runs at most once per (topic, columnCount) so partials don't re-fit on every
  // batch or fight the user's manual resizing.
  useEffect(() => {
    if (!selectedSheet) {
      return;
    }
    const key = `${selectedTopic}:${selectedSheet.columns.length}`;
    if (sizedKeyRef.current === key) {
      return;
    }
    sizedKeyRef.current = key;

    setColumnOrder([...selectedSheet.columns]);
    const sizing: ColumnSizingState = {};
    const sampleIndices = Array.from(
      { length: Math.min(selectedSheet.rowCount, AUTOSIZE_SAMPLE) },
      (_, i) => i,
    );
    for (const column of selectedSheet.columns) {
      sizing[column] = computeColumnWidth(column, selectedSheet, sampleIndices);
    }
    setColumnSizing(sizing);
  }, [selectedSheet, selectedTopic]);

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
    onRowsLoadedRef.current = onRowsLoaded;
    dataLoaderRef.current = dataLoader;
    workbookOpenerRef.current = workbookOpener;
  });

  // Report a columnar view of the current topic to the embedder once available,
  // so it can map cell values (e.g. a timestamp column) to a rowIndex without us
  // materializing per-row objects.
  useEffect(() => {
    // Only report the FINAL, fully-loaded sheet — a partial would give the
    // embedder incomplete row indices.
    if (ready && selectedSheet) {
      onRowsLoadedRef.current?.(selectedTopic, {
        topic: selectedTopic,
        rowCount: selectedSheet.rowCount,
        columns: selectedSheet.columns,
        cell: (rowIndex, column) => cellAt(selectedSheet, rowIndex, column),
        column: (name) => selectedSheet.columnData.get(name),
      });
    }
  }, [selectedSheet, selectedTopic, ready]);

  // Scroll a requested (unfiltered) row into view, when it is in the current
  // display order (i.e. not filtered out).
  useEffect(() => {
    if (scrollToRowIndex == undefined) {
      return;
    }
    const position = rowDisplayOrder.indexOf(scrollToRowIndex);
    if (position >= 0) {
      rowVirtualizer.scrollToIndex(position, { align: 'center' });
    }
  }, [scrollToRowIndex, rowDisplayOrder, rowVirtualizer]);

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
      (rowIndex, column) => cellDisplayText(column, cellAt(selectedSheet, rowIndex, column)),
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
      if (!selectedSheet) {
        return;
      }
      setColumnSizing((current) => ({
        ...current,
        [columnId]: computeColumnWidth(columnId, selectedSheet, filteredIndices),
      }));
    },
    [selectedSheet, filteredIndices],
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

    // Sorting is deferred until the topic is fully loaded — omit sort items while
    // streaming (they'd be inert and misleading).
    const items: ContextMenuItem[] = ready
      ? [
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
        ]
      : [];
    items.push({
      label: `Hide "${menu.columnId}"`,
      disabled: visibleCount <= 1,
      onSelect: () => setColumnVisibility((current) => ({ ...current, [menu.columnId]: false })),
    });

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
    ready,
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

  const progressPercent = progress ? Math.round(progress.fraction * 100) : 0;
  const progressNode = progress ? (
    <div className="mcap-sheet__status">
      {progress.phase === 'recovering' ? 'Recovering truncated file…' : 'Downloading…'} {progressPercent}%
      <div className="mcap-sheet__progress">
        <div className="mcap-sheet__progress-bar" style={{ width: `${progressPercent}%` }} />
      </div>
    </div>
  ) : null;

  return (
    <section className={`mcap-sheet ${fill ? 'mcap-sheet--fill' : ''} ${className ?? ''}`.trim()}>
      <header className="mcap-sheet__toolbar">
        <span className="mcap-sheet__meta">
          {ranged ? (
            <span className="mcap-sheet__badge" title="Reading via HTTP range requests">
              range
            </span>
          ) : null}
          {recovered ? (
            <span
              className="mcap-sheet__badge mcap-sheet__badge--recovered"
              title="Recovered from a truncated or unindexed file"
            >
              recovered
            </span>
          ) : null}
          {selectedSheet ? (
            streaming ? (
              <span className="mcap-sheet__streaming">
                <span className="mcap-sheet__spinner" aria-hidden />
                loading… {selectedSheet.rowCount.toLocaleString()} rows
                {progress ? ` (${Math.round(progress.fraction * 100)}%)` : ''}
              </span>
            ) : (
              <span>
                {filteredIndices.length.toLocaleString()} / {selectedSheet.rowCount.toLocaleString()} rows
              </span>
            )
          ) : null}
        </span>
      </header>

      {loading ? progressNode ?? <p className="mcap-sheet__status">Loading MCAP file…</p> : null}
      {error ? <p className="mcap-sheet__status mcap-sheet__status--error">{error}</p> : null}
      {!loading && !error && topics.length === 0 ? (
        <p className="mcap-sheet__status">No messages were found in this MCAP file.</p>
      ) : null}
      {showTopicStatus ? (
        topicError ? (
          <p className="mcap-sheet__status mcap-sheet__status--error">{topicError}</p>
        ) : (
          progressNode ?? <p className="mcap-sheet__status">Loading “{selectedTopic}”…</p>
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
                      {ready ? (
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
                      ) : null}
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
              {ready ? (
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
              ) : null}
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
                      const value = cell.getValue<CellValue>();
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
