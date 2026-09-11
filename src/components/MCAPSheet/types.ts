import type { CellValue } from '../../lib/mcap/worksheet';
import type { TopicWorksheet } from '../../lib/mcap/loadMcapWorkbook';

export interface MCAPSheetProps {
  url: string;
  className?: string;
  height?: number | string;
  rowHeight?: number;
  dataLoader?: (url: string) => Promise<TopicWorksheet[]>;
}

export type { TopicWorksheet, CellValue };
