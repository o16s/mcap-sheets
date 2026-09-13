import type { CellValue } from '../../lib/mcap/worksheet';
import type {
  McapWorkbookSource,
  TopicSummary,
  TopicWorksheet,
} from '../../lib/mcap/mcapWorkbook';

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
   * rows load on demand. Defaults to {@link openMcapWorkbook}.
   */
  workbookOpener?: (url: string) => Promise<McapWorkbookSource>;
}

export type { TopicWorksheet, TopicSummary, McapWorkbookSource, CellValue };
