import type { CellValue } from '../../lib/mcap/worksheet';
import type { ColumnType } from '../../lib/mcap/columnTypes';
import type {
  McapWorkbookSource,
  TopicSummary,
  TopicWorksheet,
} from '../../lib/mcap/mcapWorkbook';
import type { ColumnFilterValue } from './columnFilterModel';
import type { CellRef, MCAPSelection } from './selectionModel';

/** Highlight for a whole row, by its index into the topic's unfiltered rows. */
export interface RowHighlight {
  rowIndex: number;
  /** Any CSS color string. */
  color: string;
}

/** Highlight for a whole column, by column id. */
export interface ColumnHighlight {
  column: string;
  color: string;
}

/** Highlight for a single cell. Takes precedence over row/column highlights. */
export interface CellHighlight {
  rowIndex: number;
  column: string;
  color: string;
}

/**
 * Embedder-controlled highlights. `rowIndex` values are indices into the current
 * topic's unfiltered rows. Set `topic` to scope the highlights to a specific
 * topic — when it doesn't match the displayed topic the highlights are ignored
 * (guards against stale highlights during async topic switches).
 */
export interface MCAPHighlights {
  topic?: string;
  rows?: RowHighlight[];
  columns?: ColumnHighlight[];
  cells?: CellHighlight[];
}

export type ColumnFilters = Record<string, ColumnFilterValue>;

export interface MCAPSheetProps {
  url: string;
  className?: string;
  height?: number | string;
  /**
   * Fill the parent container's height instead of using a fixed table height.
   * The parent must have a definite height. `height` is ignored when set.
   */
  fill?: boolean;
  rowHeight?: number;
  /**
   * Eager override (used by tests/stories): returns all topic worksheets at
   * once. When provided, the component wraps the result in a lazy source.
   */
  dataLoader?: (url: string) => Promise<TopicWorksheet[]>;
  /**
   * Lazy override: opens a workbook whose topics are known up front and whose
   * rows load on demand. Defaults to `openMcapWorkbook`.
   */
  workbookOpener?: (url: string) => Promise<McapWorkbookSource>;

  // --- Embedder ↔ component communication (all optional) ---
  /** Highlight arbitrary rows/columns/cells in any color. */
  highlights?: MCAPHighlights;
  /** Enable spreadsheet-style cell selection by the user. */
  selectable?: boolean;
  /** Controlled selection. Omit to let the component manage it internally. */
  selection?: MCAPSelection;
  /** Fires whenever the user's selection changes (and on topic change → empty). */
  onSelectionChange?: (selection: MCAPSelection) => void;
  /**
   * Controlled column filters. Omit to let the component manage them.
   * Note: the `enum` filter's `selected` is a `Set<string>` (not JSON-serializable).
   */
  filters?: ColumnFilters;
  /** Fires whenever the column filters change. */
  onFiltersChange?: (filters: ColumnFilters) => void;
  /** Fires when the selected topic changes. */
  onTopicChange?: (topic: string) => void;
}

export type {
  TopicWorksheet,
  TopicSummary,
  McapWorkbookSource,
  CellValue,
  ColumnFilterValue,
  ColumnType,
  CellRef,
  MCAPSelection,
};
