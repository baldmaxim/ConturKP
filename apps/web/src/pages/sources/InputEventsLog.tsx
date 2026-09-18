import { useState, type FC } from 'react';
import { Icon } from '../../components/Icon';
import { InputEventsBody } from './InputEventsBody';
import styles from './InputEventsLog.module.css';

interface IInputEventsLogProps {
  stageId: string;
}

/** Свёрнутый блок «Журнал изменений входов» этапа. */
export const InputEventsLog: FC<IInputEventsLogProps> = ({ stageId }) => {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.details} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={styles.summary}>
        <Icon name="chevron-down" size={16} className={styles.chevron} />
        <span>Журнал изменений входов</span>
      </summary>
      {open ? <InputEventsBody stageId={stageId} /> : null}
    </details>
  );
};
