import type { FC, ReactNode } from 'react';
import { listImports } from '../../api/sourceEndpoints';
import type { IImportBatch } from '../../api/types';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { usePolling } from '../../hooks/usePolling';
import { formatDateTime } from '../../utils/datetime';
import { BATCH_SOURCE_LABELS, BATCH_STATUS } from '../../utils/sourceLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';

interface IImportBatchListProps {
  stageId: string;
  /** Меняется после принятой загрузки — список перечитывается. */
  refreshToken: number;
}

const batchLink = (batch: IImportBatch, stageId: string): string => `/imports/${batch.id}?stage=${stageId}`;

const nameOf = (batch: IImportBatch): string =>
  batch.uploadName ?? BATCH_SOURCE_LABELS[batch.sourceKind] ?? batch.sourceKind;

const unresolvedCell = (batch: IImportBatch): ReactNode =>
  batch.counts.unresolved > 0 ? (
    <Badge tone="warning" icon="hourglass" dashed label={`Без исхода: ${batch.counts.unresolved}`} />
  ) : (
    <span className={list.num}>0</span>
  );

/** Партии импорта этапа; пока есть партии в обработке — опрос каждые 3 с. */
export const ImportBatchList: FC<IImportBatchListProps> = ({ stageId, refreshToken }) => {
  const { data, error, loading, reload } = useApiResource(
    (signal) => listImports(stageId, signal),
    `${stageId}:${refreshToken}`,
  );
  const items = [...(data?.items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const running = items.some((batch) => batch.status === 'running');
  usePolling(running && !error, reload, 3000);

  const renderBody = (): ReactNode => {
    if (loading && !data) {
      return <LoadingState />;
    }
    if (error && !data) {
      return <ErrorState error={error} onRetry={reload} />;
    }
    if (items.length === 0) {
      return (
        <EmptyState
          icon="inbox"
          title="Загрузок ещё не было"
          text="Партии появятся после загрузки файлов или скана наблюдаемой папки тендера."
        />
      );
    }
    return (
      <>
        {error ? <ErrorState error={error} onRetry={reload} /> : null}
        <div className={list.tableWrap}>
          <table className={list.table}>
            <thead>
              <tr>
                <th scope="col">Время, МСК</th>
                <th scope="col">Источник</th>
                <th scope="col">Загрузка</th>
                <th scope="col">Статус</th>
                <th scope="col" className={list.right}>
                  Всего
                </th>
                <th scope="col" className={list.right}>
                  Зарег.
                </th>
                <th scope="col" className={list.right}>
                  Дубл.
                </th>
                <th scope="col" className={list.right}>
                  Откл.
                </th>
                <th scope="col">Без исхода</th>
              </tr>
            </thead>
            <tbody>
              {items.map((batch) => {
                const status = BATCH_STATUS[batch.status];
                return (
                  <tr key={batch.id}>
                    <td className={list.num}>
                      <AppLink className={list.rowLink} to={batchLink(batch, stageId)}>
                        {formatDateTime(batch.createdAt)}
                      </AppLink>
                    </td>
                    <td>{BATCH_SOURCE_LABELS[batch.sourceKind] ?? batch.sourceKind}</td>
                    <td>{batch.uploadName ?? <span className={list.muted}>—</span>}</td>
                    <td>
                      <Badge {...status} />
                    </td>
                    <td className={`${list.num} ${list.right}`}>{batch.counts.total}</td>
                    <td className={`${list.num} ${list.right}`}>{batch.counts.registered}</td>
                    <td className={`${list.num} ${list.right}`}>{batch.counts.duplicate}</td>
                    <td className={`${list.num} ${list.right}`}>{batch.counts.rejected}</td>
                    <td>{unresolvedCell(batch)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className={list.cards}>
          {items.map((batch) => (
            <li key={batch.id} className={list.card}>
              <div className={list.cardHead}>
                <AppLink className={list.rowLink} to={batchLink(batch, stageId)}>
                  {nameOf(batch)}
                </AppLink>
                <Badge {...BATCH_STATUS[batch.status]} />
              </div>
              <dl className={list.meta}>
                <dt>Время</dt>
                <dd className={list.num}>{formatDateTime(batch.createdAt)} МСК</dd>
                <dt>Источник</dt>
                <dd>{BATCH_SOURCE_LABELS[batch.sourceKind] ?? batch.sourceKind}</dd>
                <dt>Файлов</dt>
                <dd className={list.num}>
                  {`всего ${batch.counts.total} · зарег. ${batch.counts.registered} · дубл. ${batch.counts.duplicate} · откл. ${batch.counts.rejected}`}
                </dd>
                <dt>Без исхода</dt>
                <dd>{unresolvedCell(batch)}</dd>
              </dl>
            </li>
          ))}
        </ul>
      </>
    );
  };

  return (
    <section className={form.stack} aria-labelledby="batches-title">
      <div className={form.sectionHead}>
        <h2 id="batches-title" className={form.sectionTitle}>
          Партии импорта
        </h2>
        {running ? <Badge tone="info" icon="hourglass" label="Обновляется каждые 3 с" /> : null}
      </div>
      {renderBody()}
    </section>
  );
};
