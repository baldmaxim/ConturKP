import { useState, type FC } from 'react';
import { getComparison, listReasonRuns, startReasonRun } from '../../api/economicsEndpoints';
import { describeError, stateConflictCurrent } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import { formatDecimal } from '../../utils/calculationLabels';
import { COMPONENT_LABEL, FACTOR_LABEL, signed } from '../../utils/economicsLabels';
import form from '../../styles/form.module.css';
import { LineagePanel } from './LineagePanel';
import { UnitsList } from './UnitsList';
import styles from './Economics.module.css';

interface IComparisonViewProps {
  comparisonId: string;
  caps: string[];
}

const RUN_STATUS: Record<string, string> = {
  queued: 'в очереди',
  running: 'выполняется',
  completed: 'завершён',
  completed_with_gaps: 'завершён с пробелами',
  failed: 'ошибка',
};

/**
 * Сравнение двух ревизий (D-030 В-10-3, В-10-4): сводка вкладов по мерам в порядке метода, правило отнесения
 * совместного эффекта, остаток уровня тендера отдельной строкой, сопоставление позиций и единицы с причинами.
 */
export const ComparisonView: FC<IComparisonViewProps> = ({ comparisonId, caps }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const cmp = useApiResource((signal) => getComparison(comparisonId, signal), comparisonId);
  const runs = useApiResource((signal) => listReasonRuns(comparisonId, signal), comparisonId);
  const [unitsToken, setUnitsToken] = useState(0);
  const [starting, setStarting] = useState(false);
  const active = (runs.data?.items ?? []).some((r) => r.status === 'queued' || r.status === 'running');
  usePolling(active, () => {
    runs.reload();
    setUnitsToken((t) => t + 1);
  }, 2500);
  if (cmp.loading && !cmp.data) return <LoadingState />;
  if (cmp.error && !cmp.data) return <ErrorState error={cmp.error} onRetry={cmp.reload} />;
  const c = cmp.data;
  if (!c) return null;
  if (c.status === 'failed') return <Notice tone="danger">{`Сравнение не выполнено: ${c.failureReason ?? ''}`}</Notice>;

  const start = (): void => {
    setStarting(true);
    startReasonRun(comparisonId, null, idem.keyFor({ comparisonId })).then(
      () => {
        idem.reset();
        setStarting(false);
        toast.push({ kind: 'success', text: 'Модель ищет причины в источниках этапа: результат — гипотезы для подтверждения.' });
        runs.reload();
      },
      (e: unknown) => {
        setStarting(false);
        const current = stateConflictCurrent(e) as { reason?: string } | null;
        toast.push({ kind: 'error', text: current?.reason === 'no_units' ? 'Нет изменившихся единиц без подтверждённой причины.' : current?.reason === 'no_scope' ? 'Зафиксируйте снимок источников этапа.' : describeError(e) });
      },
    );
  };

  const tenderRows = (measure: 'cost' | 'commercial') => c.summary.effects.filter((x) => x.measure === measure);
  const lastRun = runs.data?.items[0] ?? null;

  return (
    <div className={form.stack}>
      <section className={form.section} aria-labelledby="econ-cmp-title">
        <div className={form.sectionHead}>
          <h3 id="econ-cmp-title" className={form.sectionTitle}>
            {`Ревизия № ${c.revisions.left.seq} → № ${c.revisions.right.seq}`}
          </h3>
          {c.outdated.value ? <Badge label="устарело" icon="repeat" tone="warning" dashed /> : <Badge label="актуально" icon="check" tone="success" />}
        </div>
        {c.outdated.lineageChanged ? <Notice tone="warning">После сравнения появились новые решения по парам — запустите сравнение заново.</Notice> : null}
        {c.outdated.invalidatedExplanations > 0 ? <Notice tone="warning">{`У ${c.outdated.invalidatedExplanations} подтверждённых причин изменилось основание.`}</Notice> : null}
        <p className={styles.muted}>
          {`Порядок подстановок: ${c.method.order.map((f) => FACTOR_LABEL[f] ?? f).join(' → ')}. ${c.method.jointEffectRule[0]?.toUpperCase() ?? ''}${c.method.jointEffectRule.slice(1)}.`}
        </p>
        {(['cost', 'commercial'] as const).map((m) => (
          <div key={m} className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={form.sectionTitle}>
                {`${m === 'cost' ? 'Себестоимость' : 'Коммерческая стоимость'}: ${formatDecimal(c.totals?.[m].left ?? null)} → ${formatDecimal(c.totals?.[m].right ?? null)} ₽ (${signed(c.totals?.[m].delta ?? null)})`}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Вклад</th>
                  <th scope="col" className={styles.num}>
                    Единиц
                  </th>
                  <th scope="col" className={styles.num}>
                    Сумма, ₽
                  </th>
                </tr>
              </thead>
              <tbody>
                {tenderRows(m).map((x) => (
                  <tr key={`${x.level}:${x.component}`}>
                    <td>{COMPONENT_LABEL[x.component] ?? x.component}</td>
                    <td className={styles.num}>{x.level === 'tender' ? 'тендер' : x.units}</td>
                    <td className={styles.num}>{signed(x.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <p className={styles.muted}>{`${c.method.tenderLevel[0]?.toUpperCase() ?? ''}${c.method.tenderLevel.slice(1)}. Остаток уровня тендера не итог КП и ничем не объясняется по данным ключа.`}</p>
        {caps.includes('economics.compare') ? (
          <div className={styles.row}>
            <Button variant="secondary" icon="scan-search" loading={starting || active} onClick={start}>
              Найти причины в источниках
            </Button>
            {lastRun ? <span className={styles.muted}>{`Последний поиск: ${RUN_STATUS[lastRun.status] ?? lastRun.status}${lastRun.coverage.gap ? ` — ${String(lastRun.coverage.gap)}` : ''}`}</span> : null}
          </div>
        ) : null}
      </section>
      <LineagePanel comparisonId={comparisonId} canDecide={caps.includes('calculation.capture')} onChanged={cmp.reload} />
      <UnitsList comparisonId={comparisonId} canConfirm={caps.includes('change_reason.confirm')} refreshToken={unitsToken} />
    </div>
  );
};
