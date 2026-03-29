import type { CSSProperties } from 'react';
import styles from './Skeleton.module.css';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  count?: number;
}

export function Skeleton({
  width = '100%',
  height = 16,
  borderRadius = 'var(--radius-sm)',
  count = 1,
}: SkeletonProps) {
  const style: CSSProperties = {
    width,
    height,
    borderRadius,
  };

  if (count === 1) {
    return <div className={styles.skeleton} style={style} />;
  }

  return (
    <div className={styles.wrapper}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.skeleton} style={style} />
      ))}
    </div>
  );
}
