/// <reference lib="webworker" />
// Runs the heavy MCAP decode (decompress + flatten) entirely off the main
// thread, streaming column-major row batches back so the UI thread only ever
// appends + renders — instant first paint with no scroll jank during the fill.
import {
  fetchSlices,
  slicesFromBlob,
  streamDecode,
  type DecodeBatch,
} from './decodeCore';

export type DecodeRequest =
  | { kind: 'url'; url: string; topic: string }
  | { kind: 'blob'; blob: Blob; topic: string };

export type DecodeResponse =
  | { type: 'batch'; batch: DecodeBatch }
  | { type: 'progress'; fraction: number }
  | { type: 'done' }
  | { type: 'error'; message: string };

const post = (message: DecodeResponse) => (self as unknown as Worker).postMessage(message);

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const request = event.data;
  try {
    const { slices, total } =
      request.kind === 'url'
        ? await fetchSlices(request.url)
        : { slices: slicesFromBlob(request.blob), total: request.blob.size };

    await streamDecode(slices, {
      topic: request.topic,
      total,
      yieldBetween: false, // no UI on this thread — decode flat out
      onBatch: (batch) => post({ type: 'batch', batch }),
      onProgress: (fraction) => post({ type: 'progress', fraction }),
    });

    post({ type: 'done' });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
