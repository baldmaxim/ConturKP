import { useEffect, useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { getReviewRun, listReviewRuns, startReviewRun } from '../../api/reviewEndpoints';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { RUN_STATUS_LABELS } from '../../utils/reviewLabels';
import { RunReport } from './RunReport';
import styles from './Review.module.css';

interface IReviewTabProps {
  stageId: string;
  caps: readonly string[];
  onOpenFindings: () => void;
}

/**
 * Проверка этапа (этап 09): запуск на закреплённых входах, отчёты прогонов. Прежние отчёты сохраняются и открываются
 * как были — с пометкой «устарел», если входы этапа изменились. «Всё проверено» — только из полного прогона.
 */
export const ReviewTab: FC<IReviewTabProps> = ({ stageId, caps, onOpenFindings }) => {
  const runs = useApiResource((signal) => listReviewRuns(stageId, signal), stageId);
  const [selected, setSelected] = useState<string>('');
  const runId = selected || runs.data?.items[0]?.id || '';
  const run = useApiResource((signal) => (runId ? getReviewRun(runId, signal) : Promise.resolve(null)), runId);
  const [busy, setBusy] = useState(false);
  const idem = useIdempotencyKey();
  const toast = useToast();
  const active = run.data && (run.data.status === 'queued' || run.data.status === 'running');
  usePolling(!!active, () => {
    run.reload();
    runs.reload();
  }, 2000);

  useEffect(() => {
    if (selected && runs.data && !runs.data.items.some((r) => r.id === selected)) setSelected('');
  }, [runs.data, selected]);

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await startReviewRun(stageId, idem.keyFor({ stageId, at: 'start' }));
      idem.reset();
      toast.push({ kind: 'info', text: r.reused ? 'Проверка уже выполняется — открыт её отчёт' : 'Проверка запущена' });
      setSelected(r.id);
      runs.reload();
    } catch (e) {
      toast.push({ kind: 'error', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  if (runs.loading && !runs.data) return <LoadingState />;
  if (runs.error || !runs.data) return <ErrorState error={runs.error} onRetry={runs.reload} />;
  const items = runs.data.items;

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        {items.length > 0 ? (
          <div>
            <SelectField
              label="Прогон проверки"
              value={runId}
              onValueChange={setSelected}
              options={items.map((r) => ({ value: r.id, label: `${r.createdAt ? formatDateTime(r.createdAt) : '—'} · ${RUN_STATUS_LABELS[r.status].label}` }))}
            />
          </div>
        ) : null}
        {caps.includes('review.run') ? (
          <Button variant="primary" icon="scan-search" className={styles.push} loading={busy} onClick={() => void start()}>
            Запустить проверку
          </Button>
        ) : null}
      </div>
      <Notice tone="info">
        Проверка закрепляет снимок источников, реестр требований, ревизию расчёта и приоритет источников. Программные проверки и гипотезы модели
        показываются отдельно; гипотеза становится замечанием только после решения человека.
      </Notice>
      {items.length === 0 ? (
        <EmptyState icon="scan-search" title="Проверок ещё не было" text="Запустите проверку: она покажет пробелы обработки, полноту реестра, покрытие, параметры, единицы, обязательства договора и конфликты источников." />
      ) : run.loading && !run.data ? (
        <LoadingState />
      ) : run.error || !run.data ? (
        <ErrorState error={run.error} onRetry={run.reload} />
      ) : (
        <>
          <div className={styles.headLine}>
            <Badge {...RUN_STATUS_LABELS[run.data.status]} />
            <span className={styles.muted}>{`Правила ${run.data.rulesVersion}${run.data.model ? ` · модель ${run.data.model.provider}/${run.data.model.model ?? ''}` : ' · модель не настроена'}`}</span>
          </div>
          <RunReport run={run.data} canWrite={caps.includes('finding.write')} onChanged={run.reload} onOpenFindings={onOpenFindings} />
        </>
      )}
    </div>
  );
};
