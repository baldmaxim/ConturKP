import type { FC } from 'react';
import type { IOfficeTask } from './officeModel';
import { officeProgress } from './officeProgress';
import styles from './Office.module.css';

export const OfficeTaskProgress: FC<{ task: IOfficeTask; frozen: boolean; compact?: boolean }> = ({ task, frozen, compact }) => {
  const { percent, label } = officeProgress(task);
  return <span className={styles.taskProgress} data-compact={compact} data-frozen={frozen}>
    <span className={styles.progressTrack} role="progressbar" aria-label={task.title ?? 'Выполнение задания'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={`${frozen ? 'Последний снимок: ' : ''}${label}`} data-indeterminate={percent === null}>
      <span style={{ width: percent === null ? '35%' : `${percent}%` }} />
    </span>
    <span className={styles.progressLabel}>{frozen ? 'Снимок · ' : ''}{compact && percent !== null ? `${percent}%` : label}</span>
  </span>;
};
