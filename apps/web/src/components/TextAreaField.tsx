import { useId, type FC, type TextareaHTMLAttributes } from 'react';
import { cx } from '../utils/cx';
import { FieldMessage } from './FieldMessage';
import styles from './Field.module.css';

interface ITextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  hint?: string;
}

export const TextAreaField: FC<ITextAreaFieldProps> = ({ label, value, onValueChange, error, hint, required, id, rows = 3, ...rest }) => {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-message`;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
        {required ? <span className={styles.required}>обязательно</span> : null}
      </label>
      <textarea
        {...rest}
        id={inputId}
        rows={rows}
        className={cx(styles.control, styles.textarea)}
        value={value}
        required={required}
        onChange={(event) => onValueChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
      />
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
};
