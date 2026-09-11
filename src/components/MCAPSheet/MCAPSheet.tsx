import { useEffect, useMemo, useState } from 'react';
import { TableVirtuoso } from 'react-virtuoso';
import { loadMcapWorkbook } from '../../lib/mcap/loadMcapWorkbook';
import type { CellValue, MCAPSheetProps, TopicWorksheet } from './types';
import './MCAPSheet.css';

const toCellText = (value: CellValue): string => {
  if (value === null) {
    return '';
  }

  return String(value);
};

const defaultLoader = (url: string) => loadMcapWorkbook(url);

export function MCAPSheet({
  url,
  className,
  height = 560,
  rowHeight = 36,
  dataLoader = defaultLoader,
}: MCAPSheetProps) {
  const [sheets, setSheets] = useState<TopicWorksheet[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string>('');
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isSubscribed = true;

    const load = async () => {
      setLoading(true);
      setError(null);
      setColumnFilters({});

      try {
        const workbook = await dataLoader(url);

        if (!isSubscribed) {
          return;
        }

        setSheets(workbook);
        setSelectedTopic((current) => {
          if (workbook.some((sheet) => sheet.topic === current)) {
            return current;
          }

          return workbook[0]?.topic ?? '';
        });
      } catch (loadError) {
        if (!isSubscribed) {
          return;
        }

        const message =
          loadError instanceof Error ? loadError.message : 'Unable to load MCAP file';
        setError(message);
        setSheets([]);
        setSelectedTopic('');
      } finally {
        if (isSubscribed) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      isSubscribed = false;
    };
  }, [url, dataLoader]);

  const selectedSheet = useMemo(
    () => sheets.find((sheet) => sheet.topic === selectedTopic) ?? sheets[0],
    [selectedTopic, sheets],
  );

  const filteredRows = useMemo(() => {
    if (!selectedSheet) {
      return [];
    }

    return selectedSheet.rows.filter((row) =>
      selectedSheet.columns.every((column) => {
        const filterValue = columnFilters[column]?.trim().toLowerCase();
        if (!filterValue) {
          return true;
        }

        return toCellText(row[column]).toLowerCase().includes(filterValue);
      }),
    );
  }, [columnFilters, selectedSheet]);

  return (
    <section className={`mcap-sheet ${className ?? ''}`.trim()}>
      <header className="mcap-sheet__toolbar">
        <span className="mcap-sheet__source" title={url}>
          {url}
        </span>
        {selectedSheet ? (
          <span className="mcap-sheet__meta">
            {filteredRows.length} / {selectedSheet.rows.length} rows
          </span>
        ) : null}
      </header>

      <nav className="mcap-sheet__tabs" aria-label="MCAP topics">
        {sheets.map((sheet) => (
          <button
            key={sheet.topic}
            type="button"
            className={`mcap-sheet__tab ${sheet.topic === selectedSheet?.topic ? 'is-active' : ''}`}
            onClick={() => {
              setSelectedTopic(sheet.topic);
              setColumnFilters({});
            }}
          >
            {sheet.topic}
          </button>
        ))}
      </nav>

      {loading ? <p className="mcap-sheet__status">Loading MCAP file…</p> : null}
      {error ? <p className="mcap-sheet__status mcap-sheet__status--error">{error}</p> : null}
      {!loading && !error && sheets.length === 0 ? (
        <p className="mcap-sheet__status">No messages were found in this MCAP file.</p>
      ) : null}

      {!loading && !error && selectedSheet ? (
        <div className="mcap-sheet__table-wrap" style={{ height }}>
          <TableVirtuoso
            data={filteredRows}
            fixedHeaderContent={() => (
              <>
                <tr>
                  {selectedSheet.columns.map((column) => (
                    <th key={column} title={column}>
                      {column}
                    </th>
                  ))}
                </tr>
                <tr>
                  {selectedSheet.columns.map((column) => (
                    <th key={`${column}__filter`}>
                      <input
                        aria-label={`Filter ${column}`}
                        type="text"
                        value={columnFilters[column] ?? ''}
                        onChange={(event) =>
                          setColumnFilters((current) => ({
                            ...current,
                            [column]: event.target.value,
                          }))
                        }
                        placeholder="Filter"
                      />
                    </th>
                  ))}
                </tr>
              </>
            )}
            itemContent={(_index, row) =>
              selectedSheet.columns.map((column) => <td key={column}>{toCellText(row[column])}</td>)
            }
            style={{ height: '100%' }}
            defaultItemHeight={rowHeight}
          />
        </div>
      ) : null}
    </section>
  );
}
