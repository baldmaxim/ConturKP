import { useId, type FC } from 'react';
import { FieldMessage } from './FieldMessage';
import styles from './Field.module.css';

export interface ISelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface ISelectFieldProps {
  label: string;
  value: string;
  options: ISelectOption[];
  onValueChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  error?: string;
  hint?: string;
}

export const SelectField: FC<ISelectFieldProps> = ({
  label,
  value,
  options,
  onValueChange,
  required,
  disabled,
  placeholder,
  error,
  hint,
}) => {
  const id = useId();
  const messageId = `${id}-message`;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required ? <span className={styles.required}>обязательно</span> : null}
      </label>
      <select
        id={id}
        className={styles.control}
        value={value}
        required={required}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
      >
        {placeholder !== undefined ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
};
