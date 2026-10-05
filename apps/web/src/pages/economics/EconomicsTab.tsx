import { useState, type FC } from 'react';
import { listCalculationRevisions } from '../../api/calculationEndpoints';
import { createComparison, listComparisons } from '../../api/economicsEndpoints';
import { describeError } from '../../api/errors';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import form from '../../styles/form.module.css';
import { ComparisonView } from './ComparisonView';
import { RevisionReport } from './RevisionReport';
import styles from './Economics.module.css';

interface IEconomicsTabProps {
  stageId: string;
  caps: string[];
}

/**
 * Экономика этапа (этап 10, D-030): отчёт ревизии расчёта и сравнение двух ревизий. Боевой выпуск с предварительной
 * ревизией по-прежнему заблокирован (X-01); итог КП портал не выводит (Q-05).
 */
export const EconomicsTab: FC<IEconomicsTabProps> = ({ stageId, caps }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const revisions = useApiResource((signal) => listCalculationRevisions(stageId, signal), stageId);
  const comparisons = useApiResource((signal) => listComparisons(stageId, signal), stageId);
  const [reportId, setReportId] = useState('');
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (revisions.loading && !revisions.data) return <LoadingState />;
  if (revisions.error && !revisions.data) return <ErrorState error={revisions.error} onRetry={revisions.reload} />;
  const list = revisions.data?.items ?? [];
  if (list.length === 0) {
    return <EmptyState icon="calculator" title="Ревизий расчёта пока нет" text="Экономика строится по выгруженным ревизиям: запросите выгрузку на вкладке «Расчёт»." />;
  }
  const options = list.map((r) => ({ value: r.id, label: `№ ${r.seq} · ${formatDateTime(r.createdAt)}` }));
  const report = reportId || list[0]!.id;
  const leftId = left || (list[1]?.id ?? '');
  const rightId = right || list[0]!.id;
  const current = selected ?? comparisons.data?.items[0]?.id ?? null;

  const run = (): void => {
    if (!leftId || !rightId || leftId === rightId) return;
    setBusy(true);
    createComparison(stageId, leftId, rightId, idem.keyFor({ leftId, rightId })).then(
      (c) => {
        idem.reset();
        setBusy(false);
        setSelected(c.id);
        comparisons.reload();
        const p = c.proposals;
        toast.push({ kind: c.status === 'ready' ? 'success' : 'error', text: c.status === 'ready' ? `Сравнение готово${p && p.proposed > 0 ? `; предложено пар: ${p.proposed}` : ''}.` : `Сравнение не выполнено: ${c.failureReason ?? ''}` });
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: `Сравнение не запущено: ${describeError(e)}` });
      },
    );
  };

  return (
    <div className={form.stack}>
      <Notice tone="warning" icon="shield-x">
        Ревизии — собственная выгрузка портала (X-01): боевой выпуск с ними заблокирован. Итог КП портал не выводит; остаток итога — не итог КП.
      </Notice>
      <SelectField label="Ревизия для отчёта" value={report} onValueChange={setReportId} options={options} />
      <RevisionReport revisionId={report} />
      <section className={form.section} aria-labelledby="econ-compare-title">
        <h2 id="econ-compare-title" className={form.sectionTitle}>
          Сравнение ревизий
        </h2>
        {list.length < 2 ? (
          <p className={styles.muted}>Для сравнения нужны две ревизии тендера.</p>
        ) : (
          <div className={styles.selectors}>
            <SelectField label="Прежняя ревизия" value={leftId} onValueChange={setLeft} options={options} />
            <SelectField label="Новая ревизия" value={rightId} onValueChange={setRight} options={options} />
            {caps.includes('economics.compare') ? (
              <div className={form.actions}>
                <Button variant="primary" icon="layers" loading={busy} disabled={leftId === rightId} onClick={run}>
                  Сравнить
                </Button>
              </div>
            ) : null}
          </div>
        )}
        {(comparisons.data?.items ?? []).length > 0 ? (
          <SelectField
            label="Сравнение"
            value={current ?? ''}
            onValueChange={setSelected}
            options={(comparisons.data?.items ?? []).map((c) => ({ value: c.id, label: `${formatDateTime(c.createdAt)} · ${c.status === 'ready' ? 'готово' : c.status === 'failed' ? 'ошибка' : 'считается'}` }))}
          />
        ) : null}
      </section>
      {current ? <ComparisonView key={current} comparisonId={current} caps={caps} /> : null}
    </div>
  );
};
