import { BlobReadable } from '@mcap/browser';
import { McapIndexedReader } from '@mcap/core';
import {
  flattenJsonPayload,
  LOG_TIME_COLUMN,
  normalizeTopicAccumulator,
  type CellValue,
  type TopicAccumulator,
} from './worksheet';

const textDecoder = new TextDecoder();

export interface TopicWorksheet {
  topic: string;
  columns: string[];
  rows: Array<Record<string, CellValue>>;
}

const decodePayload = (data: Uint8Array, shouldParseJson: boolean): unknown => {
  if (shouldParseJson) {
    const decoded = textDecoder.decode(data);

    try {
      return JSON.parse(decoded);
    } catch {
      return decoded;
    }
  }

  return btoa(String.fromCharCode(...data));
};

export const loadMcapWorkbook = async (
  url: string,
): Promise<TopicWorksheet[]> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch MCAP file (${response.status})`);
  }

  const blob = await response.blob();
  const reader = await McapIndexedReader.Initialize({
    readable: new BlobReadable(blob),
  });

  const topics = new Map<string, TopicAccumulator>();

  for await (const message of reader.readMessages()) {
    const channel = reader.channelsById.get(message.channelId);
    if (!channel) {
      continue;
    }

    const schema = reader.schemasById.get(channel.schemaId);
    const shouldParseJson =
      channel.messageEncoding.includes('json') ||
      schema?.encoding?.includes('json') ||
      false;

    const topic = channel.topic;
    const existing = topics.get(topic) ?? {
      columns: new Set<string>([LOG_TIME_COLUMN]),
      rows: [],
    };

    const decoded = decodePayload(message.data, shouldParseJson);
    const flattened = flattenJsonPayload(decoded);
    const row: Record<string, CellValue> = {
      [LOG_TIME_COLUMN]: message.logTime.toString(),
      ...flattened,
    };

    Object.keys(row).forEach((column) => existing.columns.add(column));
    existing.rows.push(row);
    topics.set(topic, existing);
  }

  return Array.from(topics.entries())
    .map(([topic, accumulator]) => {
      const normalized = normalizeTopicAccumulator(accumulator);
      return {
        topic,
        columns: normalized.columns,
        rows: normalized.rows,
      };
    })
    .sort((left, right) => left.topic.localeCompare(right.topic));
};
