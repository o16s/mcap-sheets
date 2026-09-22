// Isolates the Vite inline-worker import so it is bundled inline (base64) into
// the library — consumers get a self-contained dist with no separate worker
// asset to serve. This module is only ever dynamically imported (behind a
// `typeof Worker !== 'undefined'` guard), so it never loads in Node/test envs.
import DecodeWorker from './decode.worker?worker&inline';

export const createDecodeWorker = (): Worker => new DecodeWorker();
