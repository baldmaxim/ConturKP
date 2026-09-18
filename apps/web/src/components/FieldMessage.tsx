import type { FC } from 'react';
import { Icon } from './Icon';
import styles from './Field.module.css';

interface IFieldMessageProps {
  id: string;
  error?: string;
  hint?: string;
}

/** Ошибка поля (иконка + текст, не только красная рамка) или подсказка. */
export const FieldMessage: FC<IFieldMessageProps> = ({ id, error, hint }) => {
  if (error) {
    return (
      <p id={id} className={styles.error}>
        <Icon name="circle-x" size={16} />
        <span>{error}</span>
      </p>
    );
  }
  if (hint) {
    return (
      <p id={id} className={styles.hint}>
        {hint}
      </p>
    );
  }
  return null;
};
