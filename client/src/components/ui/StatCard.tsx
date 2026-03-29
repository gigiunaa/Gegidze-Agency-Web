import { Card } from './Card';
import styles from './StatCard.module.css';

interface StatCardProps {
  label: string;
  value: string | number;
  trend?: string;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'recording';
  className?: string;
}

export function StatCard({
  label,
  value,
  trend,
  variant = 'default',
  className,
}: StatCardProps) {
  const innerClass = [
    styles.statCard,
    variant !== 'default' ? styles[variant] : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Card className={className}>
      <div className={innerClass}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>{value}</span>
        {trend && <span className={styles.trend}>{trend}</span>}
      </div>
    </Card>
  );
}
