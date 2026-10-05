import { useState, type FC } from 'react';
import { getDeviationLines, getRevisionEconomics } from '../../api/economicsEndpoints';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDecimal } from '../../utils/calculationLabels';
import { formatDateTime } from '../../utils/datetime';
import { COMPONENT_CODE_LABEL, DEVIATION_LABEL, RECONCILIATION_LABEL, rub } from '../../utils/economicsLabels';
import form from '../../styles/form.module.css';
import styles from './Economics.module.css';

interface IRevisionReportProps {
  revisionId: string;
}

const DeviationLines: FC<{ revisionId: string; flag: string }> = ({ revisionId, flag }) => {
  const lines = useApiResource((signal) => getDeviationLines(revisionId, flag, signal), `${revisionId}:${flag}`);
  if (lines.loading && !lines.data) return <LoadingState />;
  if (lines.error && !lines.data) return <ErrorState error={lines.error} onRetry={lines.reload} />;
  const items = lines.data?.items ?? [];
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Строка</th>
            <th scope="col" className={styles.num}>
              Количество
            </th>
            <th scope="col" className={styles.num}>
              Вывод из работы
            </th>
            <th scope="col" className={styles.num}>
              Себестоимость
            </th>
            <th scope="col" className={styles.num}>
              Пересчёт
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((l) => (
            <tr key={l.externalItemId}>
              <td>{`${l.itemType} · ${l.description ?? '—'}`}</td>
              <td className={styles.num}>{formatDecimal(l.quantity)}</td>
              <td className={styles.num}>{formatDecimal(l.derivedQuantity)}</td>
              <td className={styles.num}>{formatDecimal(l.totalAmount)}</td>
              <td className={styles.num}>{l.recomputedCost === null ? 'неприменим' : formatDecimal(l.recomputedCost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {lines.data?.hasMore ? <p className={styles.muted}>Показаны первые 50 строк.</p> : null}
    </div>
  );
};

/**
 * Экономический отчёт ревизии (этап 10, D-030): составляющие по видам цены, сверка с итогом TenderHub, неподтверждённый
 * остаток (отдельно, не итог КП и не объясняется), десятичный пересчёт строк и отклонения от ограничений источника.
 */
export const RevisionReport: FC<IRevisionReportProps> = ({ revisionId }) => {
  const report = useApiResource((signal) => getRevisionEconomics(revisionId, signal), revisionId);
  const [openFlag, setOpenFlag] = useState<string | null>(null);
  if (report.loading && !report.data) return <LoadingState />;
  if (report.error && !report.data) return <ErrorState error={report.error} onRetry={report.reload} />;
  const r = report.data;
  if (!r) return null;
  const rec = r.reconciliation;
  const deviations = Object.entries(r.deviations).filter(([, n]) => n > 0);
  return (
    <section className={form.section} aria-labelledby="econ-report-title">
      <div className={form.sectionHead}>
        <h2 id="econ-report-title" className={form.sectionTitle}>
          {`Экономика ревизии № ${r.revisionSeq}`}
        </h2>
        <Badge
          label={RECONCILIATION_LABEL[rec.status] ?? rec.status}
          icon={rec.status === 'reconciled' ? 'check' : 'info'}
          tone={rec.status === 'reconciled' ? 'success' : 'warning'}
          dashed={rec.status !== 'reconciled'}
        />
      </div>
      <p className={styles.muted}>
        Суммы TenderHub — в рублях; коммерческие — как вывод из формулы «себестоимость × коэффициент». НДС неизвестен.
      </p>
      <div className={styles.cards}>
        <div className={styles.card}>
          <p className={styles.cardLabel}>Себестоимость</p>
          <p className={styles.cardValue}>{rub(r.totals.cost)}</p>
          <p className={styles.muted}>{`материалы ${rub(r.totals.materialCost)} · работы ${rub(r.totals.workCost)}`}</p>
        </div>
        <div className={styles.card}>
          <p className={styles.cardLabel}>Коммерческая стоимость строк</p>
          <p className={styles.cardValue}>{rub(r.totals.commercial)}</p>
          <p className={styles.muted}>{`колонка КП «Материалы» ${rub(r.totals.commercialMaterialColumn)} · «Работы» ${rub(r.totals.commercialWorkColumn)}`}</p>
        </div>
        <div className={styles.card}>
          <p className={styles.cardLabel}>Итог TenderHub (последнее наблюдаемое значение)</p>
          <p className={styles.cardValue}>{rub(rec.target)}</p>
          <p className={styles.muted}>{`подтверждённая часть ${rub(rec.confirmedPartRounded)} · допуск ${formatDecimal(rec.tolerance)} ₽`}</p>
        </div>
        <div className={`${styles.card} ${styles.residual}`}>
          <p className={styles.cardLabel}>Неподтверждённый остаток — не итог КП</p>
          <p className={styles.cardValue}>{rub(rec.residual)}</p>
          <p className={styles.muted}>Причина остатка по данным ключа не устанавливается и по позициям не распределяется.</p>
        </div>
      </div>
      <Notice tone="info">
        {`Недоступно по ключу TenderHub: ${r.components.map((c) => COMPONENT_CODE_LABEL[c.code] ?? c.code).join(', ')}. Эти составляющие не выводятся из других полей.`}
      </Notice>
      <dl className={form.details}>
        <dt>Курсы ревизии</dt>
        <dd className={form.num}>
          {`USD ${formatDecimal(r.rates.USD)} · EUR ${formatDecimal(r.rates.EUR)} · CNY ${formatDecimal(r.rates.CNY)}`}
          <span className={styles.muted}>{` — дата наблюдения ${r.rates.observedAt ? formatDateTime(r.rates.observedAt) : '—'}, не дата установления курса`}</span>
        </dd>
        <dt>Пересчёт строк</dt>
        <dd>{`${r.lineCheck.within} из ${r.lineCheck.lines} в допуске (отн. ${r.lineCheck.tolerance.relative}, абс. ${r.lineCheck.tolerance.absolute}); вне допуска ${r.lineCheck.outside}; формула неприменима ${r.lineCheck.notApplicable}. Полученные суммы не меняются.`}</dd>
        <dt>Строки без коммерческой стоимости</dt>
        <dd>{`${r.linesWithoutCommercial.lines} · себестоимость ${rub(r.linesWithoutCommercial.cost)}`}</dd>
        <dt>Позиции без цены единицы КП</dt>
        <dd>{`${r.positionsUnitPriceUndefined} — объём ГП пуст или равен нулю`}</dd>
      </dl>
      {deviations.length > 0 ? (
        <div className={form.stack}>
          <h3 className={form.sectionTitle}>Отклонения от ограничений источника</h3>
          <p className={styles.muted}>Строки сохранены как получены; отклонения показаны, но не исправлены.</p>
          <ul className={styles.list}>
            {deviations.map(([flag, n]) => (
              <li key={flag} className={styles.unit}>
                <div className={styles.row}>
                  <span className={styles.unitTitle}>{`${DEVIATION_LABEL[flag] ?? flag}: ${n}`}</span>
                  <Button variant="secondary" icon="list-checks" onClick={() => setOpenFlag(openFlag === flag ? null : flag)} aria-expanded={openFlag === flag}>
                    {openFlag === flag ? 'Скрыть строки' : 'Показать строки'}
                  </Button>
                </div>
                {openFlag === flag ? <DeviationLines revisionId={revisionId} flag={flag} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
};
