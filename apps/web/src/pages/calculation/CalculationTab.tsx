import { useState, type FC } from 'react';
import { getCalculationSources, listCalculationCaptures, listCalculationRevisions, requestCalculationCapture } from '../../api/calculationEndpoints';
import { describeError, stateConflictCurrent } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { REVISION_KIND } from '../../utils/calculationLabels';
import form from '../../styles/form.module.css';
import { CalculationCaptures } from './CalculationCaptures';
import { CalculationRevisionView } from './CalculationRevisionView';
import { CalculationSourcePanel } from './CalculationSourcePanel';
import styles from './Calculation.module.css';

interface ICalculationTabProps {
  stageId: string;
  canCapture: boolean;
  canAdmin: boolean;
}

/**
 * Расчёт этапа из TenderHub (этап 06): связь этапа с тендером TenderHub, выгрузки и неизменяемые
 * ревизии. Читает TenderHub сервер в фоне; интерфейс только запрашивает выгрузку и показывает итог.
 */
export const CalculationTab: FC<ICalculationTabProps> = ({ stageId, canCapture, canAdmin }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const sources = useApiResource((signal) => getCalculationSources(stageId, signal), stageId);
  const captures = useApiResource((signal) => listCalculationCaptures(stageId, signal), stageId);
  const revisions = useApiResource((signal) => listCalculationRevisions(stageId, signal), stageId);
  const [selected, setSelected] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const running = (captures.data?.items ?? []).some((c) => c.status === 'capturing');
  usePolling(running, () => {
    captures.reload();
    revisions.reload();
  }, 2000);

  const request = (): void => {
    setRequesting(true);
    requestCalculationCapture(stageId, idem.keyFor({ stageId })).then(
      () => {
        idem.reset();
        setRequesting(false);
        toast.push({ kind: 'success', text: 'Выгрузка запрошена: сервер читает TenderHub в фоне.' });
        captures.reload();
      },
      (e: unknown) => {
        setRequesting(false);
        const current = stateConflictCurrent(e) as { reason?: string } | null;
        toast.push({ kind: 'error', text: current?.reason === 'capture_in_progress' ? 'Выгрузка уже идёт.' : `Выгрузка не запрошена: ${describeError(e)}` });
        captures.reload();
      },
    );
  };

  if (sources.loading && !sources.data) return <LoadingState />;
  if (sources.error && !sources.data) return <ErrorState error={sources.error} onRetry={sources.reload} />;
  if (!sources.data) return null;

  const list = revisions.data?.items ?? [];
  const current = list.find((r) => r.id === selected) ?? list[0] ?? null;

  return (
    <div className={form.stack}>
      <CalculationSourcePanel stageId={stageId} sources={sources.data} canAdmin={canAdmin} onChanged={(next) => sources.setData(next)} />
      {captures.error ? <ErrorState error={captures.error} onRetry={captures.reload} /> : null}
      <CalculationCaptures
        captures={captures.data?.items ?? []}
        canCapture={canCapture}
        hasSource={sources.data.primary !== null}
        requesting={requesting}
        onRequest={request}
      />
      {revisions.error ? <ErrorState error={revisions.error} onRetry={revisions.reload} /> : null}
      {list.length > 0 ? (
        <section className={form.section} aria-labelledby="calc-revisions-title">
          <h2 id="calc-revisions-title" className={form.sectionTitle}>
            Ревизии расчёта
          </h2>
          <ul className={styles.revisions}>
            {list.map((r) => {
              const kind = REVISION_KIND[r.kind];
              return (
                <li key={r.id}>
                  <button type="button" className={styles.revisionButton} aria-current={current?.id === r.id} onClick={() => setSelected(r.id)}>
                    <span className={styles.number}>{`№ ${r.seq}`}</span>
                    <span className={styles.muted}>{formatDateTime(r.createdAt)}</span>
                    <Badge label={kind.label} icon={kind.icon} tone={kind.tone} dashed={kind.dashed ?? false} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {current ? <CalculationRevisionView revision={current} /> : null}
    </div>
  );
};
