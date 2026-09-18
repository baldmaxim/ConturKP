import { useId, type FC } from 'react';
import { FieldMessage } from './FieldMessage';
import styles from './Field.module.css';

interface ICheckboxOption {
  value: string;
  label: string;
}

interface ICheckboxGroupProps {
  legend: string;
  options: ICheckboxOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  required?: boolean;
  error?: string;
  hint?: string;
}

export const CheckboxGroup: FC<ICheckboxGroupProps> = ({ legend, options, selected, onChange, required, error, hint }) => {
  const id = useId();
  const messageId = `${id}-message`;
  const toggle = (value: string, checked: boolean): void => {
    onChange(checked ? [...selected, value] : selected.filter((item) => item !== value));
  };
  return (
    <fieldset className={styles.fieldset} aria-describedby={error || hint ? messageId : undefined}>
      <legend className={styles.label}>
        {legend}
        {required ? <span className={styles.required}>обязательно</span> : null}
      </legend>
      <div className={styles.options}>
        {options.map((option) => (
          <label key={option.value} className={styles.option}>
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={(event) => toggle(option.value, event.target.checked)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <FieldMessage id={messageId} error={error} hint={hint} />
    </fieldset>
  );
};
