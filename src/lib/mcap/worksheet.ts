export type CellValue = string | number | boolean | null;

// Column keys for the MCAP message timestamps, aligned with the spec's
// `log_time` / `publish_time` fields. These hold the raw nanosecond counts (as
// strings, to preserve bigint precision) for filtering/sorting; the UI renders
// them via formatTimestamp().
export const LOG_TIME_COLUMN = 'log_time';
export const PUBLISH_TIME_COLUMN = 'publish_time';
export const TIMESTAMP_COLUMNS: readonly string[] = [LOG_TIME_COLUMN, PUBLISH_TIME_COLUMN];

/**
 * Renders a nanosecond-since-epoch timestamp (as stored in the timestamp
 * columns) into a human-readable ISO 8601 string. Returns the input unchanged
 * if it is not a valid integer timestamp.
 */
export const formatTimestamp = (value: CellValue): string => {
  if (value === null || value === '') {
    return '';
  }

  let nanos: bigint;
  try {
    nanos = typeof value === 'number' ? BigInt(Math.trunc(value)) : BigInt(value);
  } catch {
    return String(value);
  }

  const millis = Number(nanos / 1_000_000n);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toISOString();
};

type FlatRow = Record<string, CellValue>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toCellValue = (value: unknown): CellValue => {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }

  return JSON.stringify(value);
};

export const flattenJsonPayload = (
  value: unknown,
  parentKey = '',
  output: FlatRow = {},
): FlatRow => {
  if (Array.isArray(value)) {
    if (value.length === 0 && parentKey) {
      output[parentKey] = '[]';
      return output;
    }

    value.forEach((item, index) => {
      const key = parentKey ? `${parentKey}.${index}` : String(index);
      flattenJsonPayload(item, key, output);
    });

    return output;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && parentKey) {
      output[parentKey] = '{}';
      return output;
    }

    entries.forEach(([key, entryValue]) => {
      const nextKey = parentKey ? `${parentKey}.${key}` : key;
      flattenJsonPayload(entryValue, nextKey, output);
    });

    return output;
  }

  if (parentKey) {
    output[parentKey] = toCellValue(value);
  } else {
    output.value = toCellValue(value);
  }

  return output;
};

export interface TopicAccumulator {
  columns: Set<string>;
  rows: Array<Record<string, CellValue>>;
}

export const normalizeTopicAccumulator = (accumulator: TopicAccumulator) => {
  // Timestamp columns lead (log_time, then publish_time); everything else is
  // sorted alphabetically after them.
  const leadRank = (column: string): number => {
    const index = TIMESTAMP_COLUMNS.indexOf(column);
    return index === -1 ? TIMESTAMP_COLUMNS.length : index;
  };

  const columns = Array.from(accumulator.columns).sort((left, right) => {
    const rankDelta = leadRank(left) - leadRank(right);
    if (rankDelta !== 0) {
      return rankDelta;
    }

    return left.localeCompare(right);
  });

  const rows = accumulator.rows.map((row) => {
    const normalized: Record<string, CellValue> = {};
    columns.forEach((column) => {
      normalized[column] = row[column] ?? null;
    });

    return normalized;
  });

  return { columns, rows };
};
