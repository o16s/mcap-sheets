import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CellValue } from '../../lib/mcap/worksheet';
import { cellKey, type ColumnType } from '../../lib/mcap/columnTypes';
import type { ColumnFilterValue } from './columnFilterModel';

const displayValue = (value: CellValue): string => (value === null ? '(empty)' : String(value));

// Compact placeholder for the numeric range bounds; keeps very large timestamps
// from overflowing the input.
const formatBound = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '';
  }
  if (Math.abs(value) >= 1e12 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(2);
  }
  return String(value);
};

const EMPTY_VALUES: readonly CellValue[] = [];

interface ControlProps {
  column: string;
  type: ColumnType;
  value: ColumnFilterValue | undefined;
  onChange: (next: ColumnFilterValue | undefined) => void;
}

function TextFilter({ column, value, onChange }: ControlProps) {
  const query = value?.kind === 'text' ? value.query : '';
  return (
    <input
      className="mcap-filter__text"
      aria-label={`Filter ${column}`}
      type="text"
      placeholder="Filter"
      value={query}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next ? { kind: 'text', query: next } : undefined);
      }}
    />
  );
}

function NumberFilter({ column, type, value, onChange }: ControlProps) {
  const current = value?.kind === 'number' ? value : { kind: 'number' as const, min: '', max: '' };

  const update = (patch: Partial<Pick<Extract<ColumnFilterValue, { kind: 'number' }>, 'min' | 'max'>>) => {
    const next = { kind: 'number' as const, min: current.min, max: current.max, ...patch };
    onChange(next.min.trim() === '' && next.max.trim() === '' ? undefined : next);
  };

  const bounds = type.kind === 'number' ? type : undefined;

  return (
    <div className="mcap-filter__range">
      <input
        className="mcap-filter__text"
        aria-label={`Min ${column}`}
        type="text"
        inputMode="decimal"
        placeholder={bounds ? formatBound(bounds.min) : 'min'}
        value={current.min}
        onChange={(event) => update({ min: event.target.value })}
      />
      <span className="mcap-filter__range-sep" aria-hidden="true">
        –
      </span>
      <input
        className="mcap-filter__text"
        aria-label={`Max ${column}`}
        type="text"
        inputMode="decimal"
        placeholder={bounds ? formatBound(bounds.max) : 'max'}
        value={current.max}
        onChange={(event) => update({ max: event.target.value })}
      />
    </div>
  );
}

function EnumFilter({ column, type, value, onChange }: ControlProps) {
  const values = type.kind === 'enum' ? type.values : EMPTY_VALUES;
  const allKeys = useMemo(() => values.map(cellKey), [values]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);

  const selected = value?.kind === 'enum' ? value.selected : new Set(allKeys);
  const isFiltered = selected.size < allKeys.length;

  const commit = (nextSelected: Set<string>) => {
    onChange(
      nextSelected.size >= allKeys.length
        ? undefined
        : { kind: 'enum', selected: nextSelected },
    );
  };

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    commit(next);
  };

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const entries = values.map((entry) => ({ key: cellKey(entry), label: displayValue(entry) }));
    if (!needle) {
      return entries;
    }
    return entries.filter((entry) => entry.label.toLowerCase().includes(needle));
  }, [values, search]);

  const selectAll = () => commit(new Set(allKeys));
  const clearAll = () => commit(new Set());

  return (
    <div className="mcap-filter__enum">
      <button
        ref={buttonRef}
        type="button"
        className={`mcap-filter__enum-btn ${isFiltered ? 'is-active' : ''}`.trim()}
        aria-label={`Filter ${column}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="mcap-filter__enum-label">
          {isFiltered ? `${selected.size} of ${allKeys.length}` : 'All'}
        </span>
        <span className="mcap-filter__enum-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <Popover anchorRef={buttonRef} onClose={() => setOpen(false)}>
          <div className="mcap-filter__popover-actions">
            <button type="button" onClick={selectAll}>
              Select all
            </button>
            <button type="button" onClick={clearAll}>
              Clear
            </button>
          </div>
          {values.length > 8 ? (
            <input
              className="mcap-filter__text mcap-filter__popover-search"
              type="text"
              placeholder="Search values"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          ) : null}
          <ul className="mcap-filter__options" role="listbox" aria-multiselectable="true">
            {visible.map((entry) => (
              <li key={entry.key}>
                <label className="mcap-filter__option">
                  <input
                    type="checkbox"
                    checked={selected.has(entry.key)}
                    onChange={() => toggle(entry.key)}
                  />
                  <span className="mcap-filter__option-label" title={entry.label}>
                    {entry.label}
                  </span>
                </label>
              </li>
            ))}
            {visible.length === 0 ? (
              <li className="mcap-filter__option-empty">No matching values</li>
            ) : null}
          </ul>
        </Popover>
      ) : null}
    </div>
  );
}

interface PopoverProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
}

// Renders popover content in a body-level portal with fixed positioning so it
// is never clipped by the virtualized table's scroll container.
function Popover({ anchorRef, onClose, children }: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) {
      return;
    }

    const reposition = () => {
      const rect = anchor.getBoundingClientRect();
      const width = 240;
      const left = Math.min(rect.left, window.innerWidth - width - 8);
      setPosition({ top: rect.bottom + 4, left: Math.max(8, left) });
    };

    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorRef, onClose]);

  if (!position) {
    return null;
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="mcap-filter__popover"
      style={{ top: position.top, left: position.left }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function ColumnFilter(props: ControlProps) {
  switch (props.type.kind) {
    case 'number':
      return <NumberFilter {...props} />;
    case 'enum':
      return <EnumFilter {...props} />;
    default:
      return <TextFilter {...props} />;
  }
}
