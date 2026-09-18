import { useId, type FC, type InputHTMLAttributes } from 'react';
import { FieldMessage } from './FieldMessage';
import styles from './Field.module.css';

interface ITextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  hint?: string;
}

export const TextField: FC<ITextFieldProps> = ({ label, value, onValueChange, error, hint, required, id, ...rest }) => {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-message`;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
        {required ? <span className={styles.required}>обязательно</span> : null}
      </label>
      <input
        {...rest}
        id={inputId}
        className={styles.control}
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
