export type CellValue = string | number | boolean | null;

export const LOG_TIME_COLUMN = '_logTime';

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
  const columns = Array.from(accumulator.columns).sort((left, right) => {
    if (left === LOG_TIME_COLUMN) {
      return -1;
    }

    if (right === LOG_TIME_COLUMN) {
      return 1;
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
