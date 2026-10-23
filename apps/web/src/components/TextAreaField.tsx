import { useId, useRef, type FC, type TextareaHTMLAttributes } from 'react';
import { cx } from '../utils/cx';
import { FieldMessage } from './FieldMessage';
import { Icon } from './Icon';
import styles from './Field.module.css';

interface ITextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  hint?: string;
  /** Крестик «Очистить» у непустого поля (не у disabled/readOnly); после очистки фокус остаётся в поле. */
  onClear?: () => void;
}

export const TextAreaField: FC<ITextAreaFieldProps> = ({ label, value, onValueChange, error, hint, required, id, rows = 3, onClear, ...rest }) => {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-message`;
  const ref = useRef<HTMLTextAreaElement>(null);
  const clearable = onClear !== undefined && value !== '' && !rest.disabled && !rest.readOnly;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
        {required ? <span className={styles.required}>обязательно</span> : null}
      </label>
      <div className={styles.controlWrap}>
        <textarea
          {...rest}
          ref={ref}
          id={inputId}
          rows={rows}
          className={cx(styles.control, styles.textarea, clearable && styles.withClear)}
          value={value}
          required={required}
          onChange={(event) => onValueChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? messageId : undefined}
        />
        {clearable ? (
          <button
            type="button"
            className={styles.clear}
            aria-label={`Очистить: ${label}`}
            onClick={() => {
              onClear?.();
              ref.current?.focus();
            }}
          >
            <Icon name="x" size={16} />
          </button>
        ) : null}
      </div>
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
};
