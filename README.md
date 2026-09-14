# @o16s/mcap-sheets

A browser-only React component library that renders [MCAP](https://mcap.dev/)
files in a spreadsheet-style UI.

**Live demo:** https://o16s.github.io/mcap-sheets/

## Install

Published to **GitHub Packages**. Add an `.npmrc` next to your `package.json`
mapping the `@o16s` scope to the GitHub registry:

```
@o16s:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` must be a GitHub personal access token with the `read:packages`
scope (GitHub Packages requires authentication even for public packages). Then:

```bash
npm install @o16s/mcap-sheets
```

## Usage

```tsx
import { MCAPSheet } from '@o16s/mcap-sheets';
import '@o16s/mcap-sheets/styles.css';

export function Example() {
  return <MCAPSheet url="https://example.com/telemetry.mcap" fill />;
}
```

- `url` — an HTTP(S) URL to an MCAP file. The server should support HTTP range
  requests (and CORS, if cross-origin) for lazy, summary-first loading; otherwise
  the whole file is downloaded.
- `fill` — fill the parent's height instead of a fixed table height (the parent
  must have a definite height).

To read a local `File`/`Blob` entirely in the browser (no upload), open it with
`openMcapWorkbookFromBlob` and pass a `workbookOpener`:

```tsx
import { MCAPSheet, openMcapWorkbookFromBlob } from '@o16s/mcap-sheets';

<MCAPSheet url={file.name} workbookOpener={() => openMcapWorkbookFromBlob(file)} />;
```

## Features

- Loads MCAP over HTTP with **range requests**: reads only the summary up front,
  then each topic's rows on demand (with a byte cache and full-download fallback).
- Pure-JS **lz4 / zstd** decompression — no WASM assets or bundler config.
- Topics as worksheet tabs (with message counts); nested JSON payloads flattened
  to `field.key1.key2` columns; `log_time` / `publish_time` rendered as ISO 8601.
- **Smart, type-aware column filters**: numeric ranges, discrete checkbox pickers,
  and text search.
- **Excel-style columns** (TanStack Table + Virtual): resize, double-click
  auto-fit, drag-to-reorder, right-click hide/show, auto-fit on load, and row
  virtualization for large sheets.

## Development

```bash
npm install
npm run dev          # demo app
npm run storybook
npm run test:unit
npm run build        # library build -> dist/
npm run build:app    # demo app build -> dist-app/
```
