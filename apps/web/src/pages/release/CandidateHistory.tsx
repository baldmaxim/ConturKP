import { useState, type FC } from 'react';
import { candidateHistory } from '../../api/releaseEndpoints';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { HISTORY_ACTIONS } from '../../utils/releaseLabels';
import styles from './Approval.module.css';

const HistoryList: FC<{ candidateId: string; version: string }> = ({ candidateId, version }) => {
  const res = useApiResource((signal) => candidateHistory(candidateId, signal), `history:${candidateId}:${version}`);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error && !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  return (
    <ol className={styles.history}>
      {(res.data?.items ?? []).map((e, n) => (
        <li key={`${e.at}:${n}`} className={styles.historyRow}>
          <span className={styles.label}>{HISTORY_ACTIONS[e.action] ?? e.action}</span>
          <span className={styles.muted}>{`${formatDateTime(e.at)}${e.actor ? ` · ${e.actor.name}` : ''}`}</span>
          {e.basis ? <span className={styles.itemText}>{e.basis}</span> : null}
        </li>
      ))}
    </ol>
  );
};

/** Журнал комплекта: кто, когда и на каком основании собрал, принял риск, согласовал, отозвал, вернул, выпустил. */
export const CandidateHistory: FC<{ candidateId: string; version: string }> = ({ candidateId, version }) => {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.details} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Журнал: автор, время, основание</summary>
      {open ? <HistoryList candidateId={candidateId} version={version} /> : null}
    </details>
  );
};
