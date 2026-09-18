import type { FC, ReactNode } from 'react';
import { listInputEvents } from '../../api/sourceEndpoints';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { principalLabel } from '../../utils/labels';
import { inputEventLabel } from '../../utils/sourceLabels';
import list from '../../styles/list.module.css';
import styles from './InputEventsLog.module.css';

const REF_LABELS: Record<string, string> = {
  import_batch: 'партия импорта',
  document_revision: 'редакция документа',
  source_set_revision: 'ревизия состава',
};

interface IInputEventsBodyProps {
  stageId: string;
}

/** Содержимое журнала: загружается только при раскрытии блока. */
export const InputEventsBody: FC<IInputEventsBodyProps> = ({ stageId }) => {
  const { data, error, loading, reload } = useApiResource((signal) => listInputEvents(stageId, signal), stageId);

  if (loading && !data) {
    return <LoadingState />;
  }
  if (error) {
    return <ErrorState error={error} onRetry={reload} />;
  }
  const items = [...(data?.items ?? [])].sort((a, b) => b.seq - a.seq);
  const body: ReactNode =
    items.length === 0 ? (
      <p className={list.muted}>Входы этапа ещё не менялись.</p>
    ) : (
      <ol className={styles.events}>
        {items.map((event) => (
          <li key={event.seq} className={styles.event}>
            <div className={styles.head}>
              <span className={styles.label}>{inputEventLabel(event.eventType)}</span>
              <span className={list.num}>{`№ ${event.seq} · ${formatDateTime(event.createdAt)} МСК`}</span>
            </div>
            <span className={styles.meta}>
              {[event.refType ? (REF_LABELS[event.refType] ?? event.refType) : null, principalLabel(event.actorKind)]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </li>
        ))}
      </ol>
    );
  return (
    <div className={styles.body}>
      <div className={styles.toolbar}>
        <span className={list.num}>{`Версия входных данных: ${data?.inputVersion ?? 0}`}</span>
        <Button variant="ghost" icon="refresh-cw" onClick={reload} loading={loading}>
          Обновить
        </Button>
      </div>
      {body}
    </div>
  );
};
