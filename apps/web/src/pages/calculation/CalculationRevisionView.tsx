import type { FC } from 'react';
import type { ICalculationRevision } from '../../api/calculationTypes';
import { Badge } from '../../components/Badge';
import { Notice } from '../../components/Notice';
import { formatDateTime } from '../../utils/datetime';
import { formatDecimal, formatMoney, REVISION_KIND } from '../../utils/calculationLabels';
import form from '../../styles/form.module.css';
import { CalculationPositions } from './CalculationPositions';
import styles from './Calculation.module.css';

interface ICalculationRevisionViewProps {
  revision: ICalculationRevision;
}

const GRAND_TOTAL_STATUS: Record<string, string> = {
  ok: 'сходится с суммой КП позиций',
  rounding: 'отличается от суммы КП позиций в пределах допуска',
  mismatch: 'не сходится с суммой КП позиций',
  unavailable: 'источник итога не отдал',
};

/**
 * Неизменяемая ревизия расчёта. Пока TenderHub не отдаёт закрытую ревизию (X-01), ревизии —
 * предварительные, и боевой выпуск с ними заблокирован (CALCULATION_PROVISIONAL). Итог КП портал
 * не выводит, пока владелец не задал правило (Q-05): показываются значения источника.
 */
export const CalculationRevisionView: FC<ICalculationRevisionViewProps> = ({ revision }) => {
  const kind = REVISION_KIND[revision.kind];
  const aggregates = revision.aggregates;
  const mismatches = aggregates?.checks.reduce((sum, c) => sum + c.mismatch, 0) ?? 0;
  return (
    <section className={form.section} aria-labelledby="calc-revision-title">
      <div className={form.sectionHead}>
        <h2 id="calc-revision-title" className={form.sectionTitle}>
          {`Ревизия № ${revision.seq}`}
        </h2>
        <Badge label={kind.label} icon={kind.icon} tone={kind.tone} dashed={kind.dashed ?? false} />
      </div>
      {!revision.productionGate.allowed ? (
        <Notice tone="warning" icon="shield-x">
          TenderHub не отдаёт закрытую неизменяемую ревизию (X-01): это собственная выгрузка портала. Боевой выпуск с ней заблокирован
          (CALCULATION_PROVISIONAL); тестовый выпуск возможен.
        </Notice>
      ) : null}
      {revision.kpTotal.value === null ? (
        <Notice tone="info">
          Правило итога КП владелец ещё не задал (Q-05): портал итог КП не выводит. Ниже — значения TenderHub как есть; валюта сумм
          источником не указана.
        </Notice>
      ) : null}
      <dl className={form.details}>
        <dt>Тендер TenderHub</dt>
        <dd>
          {revision.source.tenderNumber ?? '—'}
          {revision.externalVersion !== null ? ` · версия ${revision.externalVersion}` : ''}
          {revision.source.title ? ` · ${revision.source.title}` : ''}
        </dd>
        <dt>Выгружено</dt>
        <dd>{`${formatDateTime(revision.createdAt)} · позиций ${revision.counts.positions}, строк ${revision.counts.lines}`}</dd>
        {/* Значение источника; итогом КП портала не объявлено (Q-05). */}
        <dt>Итог тендера в TenderHub (cached_grand_total)</dt>
        <dd className={form.num}>
          {formatMoney(revision.source.grandTotal)}
          {aggregates ? <span className={styles.muted}>{` — ${GRAND_TOTAL_STATUS[aggregates.grandTotal.status] ?? ''}`}</span> : null}
        </dd>
        <dt>Курсы TenderHub</dt>
        <dd className={form.num}>{`USD ${formatDecimal(revision.source.fxRates.USD)} · EUR ${formatDecimal(revision.source.fxRates.EUR)} · CNY ${formatDecimal(revision.source.fxRates.CNY)}`}</dd>
        <dt>Закрытие у источника</dt>
        <dd>
          {revision.closureAvailable
            ? revision.sourceStatus.map((s) => `${s.status} ${formatDateTime(s.observedAt)}`).join(' · ') || 'событий нет'
            : 'недоступно до X-01: TenderHub не отдаёт статус закрытия'}
        </dd>
      </dl>
      {mismatches > 0 ? (
        <Notice tone="warning">{`Суммы строк не сходятся с итогами позиций источника: ${mismatches}. Расхождение показано как есть и не подгоняется.`}</Notice>
      ) : null}
      <CalculationPositions revisionId={revision.id} />
    </section>
  );
};
