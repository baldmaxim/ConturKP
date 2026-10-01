import { useEffect, useState, type FC } from 'react';
import { newUuid } from '../../api/client';
import { describeError } from '../../api/errors';
import { listAnalysisRuns, startAnalysis } from '../../api/requirementEndpoints';
import type { IAnalysisRun, TAnalysisTask } from '../../api/requirementTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { ANALYSIS_STATUS_LABELS } from '../../utils/requirementLabels';
import styles from './Requirements.module.css';

const TASK_LABELS: Record<TAnalysisTask, string> = { requirement_extraction: 'Кандидаты требований', fact_extraction: 'Кандидаты фактов' };

const statusBadge = (r: IAnalysisRun) =>
  r.status === 'completed' ? (
    <Badge tone="success" icon="check" label={ANALYSIS_STATUS_LABELS[r.status] ?? r.status} />
  ) : r.status === 'failed' ? (
    <Badge tone="danger" icon="circle-x" label={`${ANALYSIS_STATUS_LABELS[r.status]}: ${r.failureCode ?? ''}`} />
  ) : r.status === 'completed_with_gaps' ? (
    <Badge tone="warning" icon="clock-alert" dashed label={ANALYSIS_STATUS_LABELS[r.status] ?? r.status} />
  ) : (
    <Badge tone="info" icon="loader-circle" dashed label={ANALYSIS_STATUS_LABELS[r.status] ?? r.status} />
  );

/**
 * Прогоны анализа (OD-08-2, «Model run»): модель предлагает кандидатов по зафиксированному снимку и только по
 * фрагментам, которые вы можете читать; повтор с теми же входами возвращает прежний прогон. «Ничего не найдено»
 * полноты не доказывает (A44) — полнота отдельно, по фрагментам.
 */
export const AnalysisPanel: FC<{ registryId: string; canRun: boolean }> = ({ registryId, canRun }) => {
  const [version, setVersion] = useState(0);
  const res = useApiResource((signal) => listAnalysisRuns(registryId, signal), `runs:${registryId}:${version}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const pending = (res.data?.items ?? []).some((r) => r.status === 'queued' || r.status === 'running');
  useEffect(() => {
    if (!pending) return undefined;
    const t = window.setInterval(() => res.reload(), 3000);
    return () => window.clearInterval(t);
  }, [pending, res]);
  const start = async (task: TAnalysisTask): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const run = await startAnalysis(registryId, task, newUuid());
      toast.push({ kind: 'info', text: run.reused ? 'Прогон с теми же входами уже есть — показан он' : `Прогон поставлен в очередь${run.excludedByAccess ? `; без доступа исключено фрагментов: ${run.excludedByAccess}` : ''}` });
      setVersion((v) => v + 1);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  return (
    <div className={styles.stack}>
      {canRun ? (
        <div className={styles.actions}>
          <Button variant="primary" icon="scan-search" loading={busy} onClick={() => void start('requirement_extraction')}>
            Найти кандидатов требований
          </Button>
          <Button variant="secondary" icon="scan-search" disabled={busy} onClick={() => void start('fact_extraction')}>
            Найти кандидатов фактов
          </Button>
        </div>
      ) : (
        <Notice tone="info">Запуск анализа недоступен: модель не настроена или нет права analysis.run.</Notice>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {res.data.items.length === 0 ? (
        <EmptyState icon="scan-search" title="Прогонов не было" text="Модель ещё не запускалась — это не «требований нет»." />
      ) : (
        <ul className={styles.cards}>
          {res.data.items.map((r) => (
            <li key={r.id} className={styles.card}>
              <div className={styles.headLine}>
                <strong>{TASK_LABELS[r.task]}</strong>
                {statusBadge(r)}
                {r.attempt > 1 ? <Badge tone="neutral" icon="repeat" label={`Попытка ${r.attempt}`} /> : null}
              </div>
              <p className={styles.muted}>{`${r.providerId} · ${r.modelId} (${r.modelVersion}) · ${r.promptVersion} · ${formatDateTime(r.createdAt)} МСК`}</p>
              <p className={styles.muted}>
                {`Фрагментов на входе: ${r.inputCount}; пачек: ${r.coverage.batchesProcessed ?? 0} из ${r.coverage.batchesTotal ?? '—'}${r.coverage.batchesFailed ? `, с ошибкой ${r.coverage.batchesFailed}` : ''}; кандидатов: ${r.coverage.candidatesSaved ?? 0}`}
                {r.coverage.dropped && Object.keys(r.coverage.dropped).length > 0 ? `; отброшено до записи: ${Object.values(r.coverage.dropped).reduce((a, b) => a + b, 0)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
