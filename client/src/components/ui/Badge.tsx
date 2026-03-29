import type { ReactNode } from 'react';
import styles from './Badge.module.css';

type BadgeVariant =
  | 'scheduled'
  | 'recording'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'admin'
  | 'manager'
  | 'user'
  | 'info';

interface BadgeProps {
  variant: BadgeVariant;
  children: ReactNode;
}

export function Badge({ variant, children }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[variant]}`}>
      {children}
    </span>
  );
}
