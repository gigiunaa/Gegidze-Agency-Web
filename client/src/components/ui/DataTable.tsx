import type { ReactNode } from 'react';
import styles from './DataTable.module.css';

export interface Column<T> {
  key: string;
  label: string;
  width?: string;
  render?: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
}

export function DataTable<T>({
  columns,
  data,
  onRowClick,
  emptyMessage = 'No data to display',
}: DataTableProps<T>) {
  const gridTemplate = columns
    .map((col) => col.width ?? '1fr')
    .join(' ');

  if (data.length === 0) {
    return (
      <div className={styles.wrapper}>
        <p
          style={{
            textAlign: 'center',
            padding: '32px 16px',
            color: 'var(--color-text-muted)',
            fontSize: '14px',
          }}
        >
          {emptyMessage}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.table}>
        {/* Header */}
        <div
          className={styles.headerRow}
          style={{ gridTemplateColumns: gridTemplate }}
        >
          {columns.map((col) => (
            <div key={col.key} className={styles.headerCell}>
              {col.label}
            </div>
          ))}
        </div>

        {/* Rows */}
        {data.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className={`${styles.row} ${onRowClick ? styles.rowClickable : ''}`}
            style={{ gridTemplateColumns: gridTemplate }}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {columns.map((col) => (
              <div key={col.key} className={styles.cell}>
                {col.render
                  ? col.render(row)
                  : ((row as Record<string, unknown>)[col.key] as ReactNode) ?? '—'}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
