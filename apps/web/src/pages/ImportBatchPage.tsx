import { useState, type FC } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getTender } from '../api/endpoints';
import { getImport } from '../api/sourceEndpoints';
import type { IImportBatchDetail, IImportItem } from '../api/types';
import { Badge } from '../components/Badge';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { useApiResource } from '../hooks/useApiResource';
import { usePolling } from '../hooks/usePolling';
import { useToast } from '../hooks/useToast';
import { formatDateTime } from '../utils/datetime';
import { BATCH_SOURCE_LABELS, BATCH_STATUS, needsOutcome } from '../utils/sourceLabels';
import form from '../styles/form.module.css';
import { ImportItemsList } from './sources/ImportItemsList';
import { ResolveItemDialog } from './sources/ResolveItemDialog';

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: 'в очереди',
  running: 'выполняется',
  succeeded: 'выполнено',
  failed: 'сбой',
  cancelled: 'отменено',
};

const jobsText = (jobs: Record<string, number>): string =>
  Object.entries(jobs)
    .map(([status, count]) => `${JOB_STATUS_LABELS[status] ?? status}: ${count}`)
    .join(' · ');

/** Карточка партии импорта: элементы, причины отказа, исходы отклонённых файлов. */
export const ImportBatchPage: FC = () => {
  const { importId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const [resolving, setResolving] = useState<IImportItem | null>(null);
  const batchRes = useApiResource((signal) => getImport(importId, signal), importId);
  const batch = batchRes.data;
  const tenderId = batch?.tenderId ?? '';
  const tenderRes = useApiResource((signal) => (tenderId ? getTender(tenderId, signal) : Promise.resolve(null)), tenderId);
  usePolling(batch?.status === 'running' && !batchRes.error, batchRes.reload, 3000);

  if (batchRes.loading && !batch) {
    return <LoadingState />;
  }
  if (batchRes.error && !batch) {
    return <ErrorState error={batchRes.error} onRetry={batchRes.reload} notFoundTitle="Партия не найдена или нет доступа" />;
  }
  if (!batch) {
    return null;
  }

  const stageId = searchParams.get('stage') ?? batch.stageId;
  const caps = tenderRes.data?.capabilities ?? [];
  const canReimport = caps.includes('source.write');
  const canDecide = caps.includes('hold.resolve');
  const running = batch.status === 'running';
  const unresolved = batch.items.filter(needsOutcome).length;
  const back = stageId
    ? { to: `/stages/${stageId}?tab=imports`, label: 'К этапу' }
    : { to: `/tenders/${batch.tenderId}`, label: tenderRes.data ? `${tenderRes.data.code} · ${tenderRes.data.title}` : 'К тендеру' };

  const onResolved = (updated: IImportItem): void => {
    setResolving(null);
    batchRes.setData((current: IImportBatchDetail | null) =>
      current ? { ...current, items: current.items.map((i) => (i.id === updated.id ? updated : i)) } : current,
    );
    toast.push({ kind: 'success', text: 'Исход файла записан.' });
    batchRes.reload();
  };

  const onStale = (message: string): void => {
    setResolving(null);
    toast.push({ kind: 'info', text: message });
    batchRes.reload();
  };

  return (
    <>
      <PageHeader
        back={back}
        title={`Партия импорта от ${formatDateTime(batch.createdAt)} МСК`}
        subtitle={<Badge {...BATCH_STATUS[batch.status]} />}
      />
      <div className={form.stack}>
        {batchRes.error ? <ErrorState error={batchRes.error} onRetry={batchRes.reload} /> : null}
        {running ? (
          <Notice tone="info" icon="hourglass">
            Партия обрабатывается. Страница обновляется каждые 3 с; исход отклонённых файлов можно задать после завершения.
          </Notice>
        ) : null}
        {unresolved > 0 ? (
          <Notice tone="warning" icon="file-exclamation-point">
            {`Файлов без исхода: ${unresolved}. Нужен исход: повторный импорт или решение руководителя — без него этап не будет готов.`}
          </Notice>
        ) : null}

        <section className={form.section} aria-labelledby="batch-summary">
          <h2 id="batch-summary" className={form.sectionTitle}>
            Сводка
          </h2>
          <dl className={form.details}>
            <dt>Источник</dt>
            <dd>{BATCH_SOURCE_LABELS[batch.sourceKind] ?? batch.sourceKind}</dd>
            {batch.uploadName ? (
              <>
                <dt>Загруженный файл</dt>
                <dd className={form.mono}>{batch.uploadName}</dd>
              </>
            ) : null}
            <dt>Принята</dt>
            <dd className={form.num}>{formatDateTime(batch.createdAt)} МСК</dd>
            <dt>Завершена</dt>
            <dd className={form.num}>
              {batch.completedAt ? `${formatDateTime(batch.completedAt)} МСК` : <span className={form.absent}>ещё обрабатывается</span>}
            </dd>
            <dt>Файлов</dt>
            <dd className={form.num}>
              {`всего ${batch.counts.total} · зарегистрировано ${batch.counts.registered} · дубликатов ${batch.counts.duplicate} · отклонено ${batch.counts.rejected} · ожидает ${batch.counts.pending}`}
            </dd>
            {batch.failureCode ? (
              <>
                <dt>Код сбоя</dt>
                <dd className={form.mono}>{batch.failureCode}</dd>
              </>
            ) : null}
            {Object.keys(batch.jobs).length > 0 ? (
              <>
                <dt>Задания разбора</dt>
                <dd>{jobsText(batch.jobs)}</dd>
              </>
            ) : null}
          </dl>
        </section>

        <section className={form.stack} aria-labelledby="batch-items">
          <h2 id="batch-items" className={form.sectionTitle}>
            Файлы партии
          </h2>
          <ImportItemsList
            items={batch.items}
            canResolve={!running && (canReimport || canDecide)}
            onResolve={setResolving}
          />
        </section>
      </div>

      {resolving ? (
        <ResolveItemDialog
          item={resolving}
          stageId={stageId}
          canReimport={canReimport}
          canDecide={canDecide}
          onClose={() => setResolving(null)}
          onResolved={onResolved}
          onStale={onStale}
        />
      ) : null}
    </>
  );
};
