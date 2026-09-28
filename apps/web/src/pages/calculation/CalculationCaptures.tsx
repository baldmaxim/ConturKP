import type { FC } from 'react';
import type { ICalculationCapture } from '../../api/calculationTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { formatDateTime } from '../../utils/datetime';
import { ATTEMPT_REASON, CAPTURE_STATUS, captureFailureText, failureText } from '../../utils/calculationLabels';
import form from '../../styles/form.module.css';
import styles from './Calculation.module.css';

interface ICalculationCapturesProps {
  captures: ICalculationCapture[];
  canCapture: boolean;
  hasSource: boolean;
  requesting: boolean;
  onRequest: () => void;
}

const attemptText = (c: ICalculationCapture): string | null => {
  const last = c.attempts[c.attempts.length - 1];
  if (!last || c.status === 'complete') return null;
  if (last.outcome === 'inconsistent') {
    const reasons = (last.reasons ?? []).map((r) => ATTEMPT_REASON[r.code] ?? r.code);
    return `Попытка ${c.attempts.length}: ${[...new Set(reasons)].join('; ')}.`;
  }
  return `Попытка ${c.attempts.length}: ${failureText(last.code)}`;
};

/**
 * Выгрузки расчёта: идёт, завершена, данные менялись во время чтения (inconsistent), не удалась.
 * Выгрузку выполняет сервер в фоне; при изменении данных посреди чтения она повторяется сама.
 */
export const CalculationCaptures: FC<ICalculationCapturesProps> = ({ captures, canCapture, hasSource, requesting, onRequest }) => (
  <section className={form.section} aria-labelledby="calc-captures-title">
    <div className={form.sectionHead}>
      <h2 id="calc-captures-title" className={form.sectionTitle}>
        Выгрузки
      </h2>
      {canCapture ? (
        <Button variant="primary" icon="download" loading={requesting} disabled={!hasSource} onClick={onRequest}>
          Выгрузить расчёт
        </Button>
      ) : null}
    </div>
    {captures.length === 0 ? (
      <p className={styles.muted}>Выгрузок ещё не было.</p>
    ) : (
      <ul className={styles.list}>
        {captures.map((c) => {
          const meta = CAPTURE_STATUS[c.status];
          const failure = captureFailureText(c);
          const attempt = attemptText(c);
          return (
            <li key={c.id} className={styles.card}>
              <div className={styles.cardHead}>
                <Badge label={meta.label} icon={meta.icon} tone={meta.tone} dashed={meta.dashed ?? false} />
                <span className={styles.muted}>
                  {formatDateTime(c.createdAt)}
                  {c.trigger === 'deadline' ? ' · по сроку подачи из TenderHub' : ''}
                </span>
              </div>
              {c.sourceObserved ? (
                <p className={styles.line}>
                  {`TenderHub ${c.sourceObserved.tenderNumber}`}
                  {c.sourceObserved.version !== null ? ` · версия ${c.sourceObserved.version}` : ''}
                  {c.sourceObserved.submissionDeadline ? ` · срок подачи ${formatDateTime(c.sourceObserved.submissionDeadline)}` : ''}
                </p>
              ) : null}
              {failure ? <p className={styles.problem}>{failure}</p> : null}
              {attempt && !failure ? <p className={styles.muted}>{attempt}</p> : null}
            </li>
          );
        })}
      </ul>
    )}
  </section>
);
