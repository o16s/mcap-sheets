import type { IReadable } from '@mcap/core';

// Below this size a single full download beats many ranged round-trips, so we
// don't bother with range requests.
export const MIN_RANGE_BYTES = 2 * 1024 * 1024;

export interface RangeProbe {
  /** Whether the server advertised byte-range support. */
  supported: boolean;
  /** Total file size in bytes, when the server reported it. */
  size?: bigint;
}

const safeBigInt = (value: string | null | undefined): bigint | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
};

const sizeFromContentLength = (response: Response): bigint | undefined =>
  safeBigInt(response.headers.get('Content-Length'));

// Parses the total size from a `Content-Range: bytes 0-0/12345` header.
const sizeFromContentRange = (response: Response): bigint | undefined => {
  const total = response.headers.get('Content-Range')?.split('/')[1];
  return total && total !== '*' ? safeBigInt(total) : undefined;
};

/**
 * Probes whether the server honors HTTP range requests for a URL by issuing a
 * one-byte ranged GET and checking for `206 Partial Content`. This is more
 * reliable than a HEAD + `Accept-Ranges` check, since many servers honor
 * ranges without advertising the header. Any failure is reported as
 * unsupported so the caller can fall back to a full download.
 */
export const probeRangeSupport = async (url: string): Promise<RangeProbe> => {
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' } });

    if (response.status === 206) {
      // Content-Range carries the total size; Content-Length here is just 1.
      const size = sizeFromContentRange(response) ?? sizeFromContentLength(response);
      await response.arrayBuffer().catch(() => undefined);
      return { supported: true, size };
    }

    // The server ignored the Range header and is returning the full body.
    // Discard it rather than buffering the whole file during a probe.
    await response.body?.cancel().catch(() => undefined);
    return { supported: false, size: sizeFromContentLength(response) };
  } catch {
    return { supported: false };
  }
};

/**
 * An {@link IReadable} that fetches byte ranges on demand via HTTP `Range`
 * requests, so `McapIndexedReader` can read only the footer, summary, and the
 * chunks it needs instead of the whole file.
 */
export class RangeReadable implements IReadable {
  readonly #url: string;
  readonly #byteLength: bigint;

  constructor(url: string, byteLength: bigint) {
    this.#url = url;
    this.#byteLength = byteLength;
  }

  async size(): Promise<bigint> {
    return this.#byteLength;
  }

  async read(offset: bigint, length: bigint): Promise<Uint8Array> {
    if (length === 0n) {
      return new Uint8Array(0);
    }

    const end = offset + length - 1n;
    const response = await fetch(this.#url, {
      headers: { Range: `bytes=${offset}-${end}` },
    });

    if (response.status !== 206) {
      throw new Error(
        `Expected 206 Partial Content for range ${offset}-${end}, got HTTP ${response.status}`,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}

/**
 * Wraps an {@link IReadable} and caches read results keyed by (offset, length),
 * capped at `maxBytes`. Because MCAP chunks are read at stable offsets, this
 * means each chunk is fetched at most once even when several topics share it —
 * so browsing multiple topics doesn't re-download the same bytes. Reads past
 * the cap pass through uncached.
 */
export class CachingReadable implements IReadable {
  readonly #inner: IReadable;
  readonly #maxBytes: number;
  readonly #cache = new Map<string, Uint8Array>();
  #cachedBytes = 0;

  constructor(inner: IReadable, maxBytes: number) {
    this.#inner = inner;
    this.#maxBytes = maxBytes;
  }

  size(): Promise<bigint> {
    return this.#inner.size();
  }

  async read(offset: bigint, length: bigint): Promise<Uint8Array> {
    const key = `${offset}:${length}`;
    const cached = this.#cache.get(key);
    if (cached) {
      return cached;
    }

    const data = await this.#inner.read(offset, length);
    if (this.#cachedBytes + data.byteLength <= this.#maxBytes) {
      this.#cache.set(key, data);
      this.#cachedBytes += data.byteLength;
    }
    return data;
  }
}
