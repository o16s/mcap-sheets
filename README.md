# mcap-sheets

`mcap-sheets` is a browser-only React component library that renders MCAP files in a spreadsheet-style UI.

## Install

```bash
npm install mcap-sheets
```

## Usage

```tsx
import { MCAPSheet } from 'mcap-sheets';

export function Example() {
  return <MCAPSheet url="https://example.com/telemetry.mcap" />;
}
```

## Features

- Browser-only MCAP loading from URL
- Topics mapped to worksheet tabs
- Nested JSON payload flattening (`field.key1.key2.varname`)
- Virtualized row rendering via `react-virtuoso`
- Read-only viewer (no editing)

## Development

```bash
npm install
npm run dev
npm run storybook
npm run test:unit
npm run build
```
