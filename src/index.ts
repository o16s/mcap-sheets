export { MCAPSheet, openMcapWorkbook, openMcapWorkbookFromBlob } from './components/MCAPSheet';
export type {
  MCAPSheetProps,
  TopicWorksheet,
  TopicSummary,
  McapWorkbookSource,
  CellValue,
  ColumnFilterValue,
  ColumnType,
  ColumnFilters,
  MCAPHighlights,
  RowHighlight,
  ColumnHighlight,
  CellHighlight,
  MCAPSelection,
  CellRef,
  SortSpec,
} from './components/MCAPSheet';

// Pure worksheet helpers, exposed so external hosts (e.g. an embedding app that
// feeds rows from its own message source rather than a URL) can build
// TopicWorksheets with the exact same column semantics as the URL loader.
export {
  flattenJsonPayload,
  normalizeTopicAccumulator,
  formatTimestamp,
  LOG_TIME_COLUMN,
  PUBLISH_TIME_COLUMN,
  TIMESTAMP_COLUMNS,
} from './lib/mcap/worksheet';
export type { TopicAccumulator } from './lib/mcap/worksheet';
