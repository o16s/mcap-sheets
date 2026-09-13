// lz4js ships no type definitions; declare the minimal surface we use.
declare module 'lz4js' {
  /** Decompress an LZ4 frame (auto-detects the frame header). */
  export function decompress(input: Uint8Array): Uint8Array;
  const lz4js: { decompress: typeof decompress };
  export default lz4js;
}
