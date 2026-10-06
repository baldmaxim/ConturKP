import type { FC } from 'react';
import type { IFormIssue } from '../../api/formsTypes';
import { ISSUE_LABEL } from '../../utils/formsLabels';
import styles from './Forms.module.css';

interface IIssuesListProps {
  issues: IFormIssue[];
  onOpen: (fieldKey: string | null) => void;
}

/** Понятный список незавершённых пунктов: блокирующие — сначала; «не сверено» видно, но «заполнено» не блокирует. */
export const IssuesList: FC<IIssuesListProps> = ({ issues, onOpen }) => {
  if (issues.length === 0) return <p className={styles.muted}>Незавершённых пунктов нет.</p>;
  return (
    <ul className={styles.issues} aria-label="Незавершённые пункты">
      {issues.map((i, n) => (
        <li key={`${i.kind}:${i.fieldKey ?? i.label}:${n}`}>
          <button type="button" className={[styles.issue, i.blocking ? styles.issueBlocking : ''].join(' ')} onClick={() => onOpen(i.fieldKey)}>
            <span className={styles.issueKind}>{`${ISSUE_LABEL[i.kind]}${i.blocking ? '' : ' (не блокирует)'}`}</span>
            <span>{i.fieldKey ? i.label : i.message}</span>
            {i.fieldKey ? <span className={styles.muted}>{i.message}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
};
