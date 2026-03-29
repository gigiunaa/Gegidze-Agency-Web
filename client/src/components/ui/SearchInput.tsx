import { forwardRef, type InputHTMLAttributes } from 'react';
import styles from './SearchInput.module.css';

interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type'> {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ value, onChange, placeholder = 'Search...', className, ...rest }, ref) => {
    return (
      <div className={`${styles.wrapper} ${className ?? ''}`}>
        <span className={styles.icon} aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input
          ref={ref}
          className={styles.input}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          {...rest}
        />
        {value && (
          <button
            type="button"
            className={styles.clear}
            onClick={() => onChange('')}
            aria-label="Clear search"
          >
            &times;
          </button>
        )}
      </div>
    );
  },
);

SearchInput.displayName = 'SearchInput';
