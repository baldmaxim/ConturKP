import { useState, type FC } from 'react';
import { closeCalculation, getCalculationClosure, revokeCalculationClosure } from '../../api/calculationEndpoints';
import type { IClosureState } from '../../api/calculationTypes';
import { describeError } from '../../api/errors';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { ReasonDialog } from '../release/ReasonDialog';
import styles from './Calculation.module.css';

interface IClosurePanelProps {
  revisionId: string;
  kind: 'provisional' | 'verified';
}

type TAction = 'close' | 'revoke';

/**
 * Закрытый расчёт решением руководителя (D-044, Q-01). Закрытие у источника (X-01) недоступно: решение руководителя тендера
 * заменяет его для боевого выпуска, но закрытием в TenderHub не является. Решение — на эту ревизию, отзывное; новая
 * выгрузка — новая ревизия, не закрыта. Видят все участники; кнопки — руководителю (право проверяет сервер).
 */
export const CalculationClosurePanel: FC<IClosurePanelProps> = ({ revisionId, kind }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const res = useApiResource((signal) => getCalculationClosure(revisionId, signal), revisionId);
  const [action, setAction] = useState<TAction | null>(null);
  const [busy, setBusy] = useState(false);
  if (kind !== 'provisional') return null;
  const state = res.data;
  if (!state) return null;

  const submit = (reason: string): void => {
    if (!action) return;
    const call = action === 'close' ? closeCalculation : revokeCalculationClosure;
    setBusy(true);
    call(revisionId, reason, idem.keyFor({ action, revisionId, reason })).then(
      (next: IClosureState) => {
        idem.reset();
        setBusy(false);
        setAction(null);
        res.setData(next);
        toast.push({ kind: 'success', text: action === 'close' ? 'Расчёт зафиксирован как закрытый решением руководителя' : 'Решение о закрытом расчёте отозвано' });
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
        res.reload();
      },
    );
  };

  const revoked = state.history.find((d) => d.revocation !== null) ?? null;
  return (
    <div className={styles.closure}>
      {state.active ? (
        <Notice tone="success" icon="shield-check">
          <strong>Закрыт решением руководителя</strong>
          {` (${formatDateTime(state.active.decidedAt)}, ${state.active.decidedBy.name}). Причина: ${state.active.reason}`}
        </Notice>
      ) : revoked?.revocation ? (
        <Notice tone="warning">
          <strong>Решение отозвано</strong>
          {` (${revoked.revocation.revokedAt ? formatDateTime(revoked.revocation.revokedAt) : '—'}, ${revoked.revocation.revokedBy.name ?? '—'}). Причина: ${revoked.revocation.reason ?? '—'}`}
        </Notice>
      ) : null}
      {state.canDecide || state.canRevoke ? (
        <div className={styles.closureActions}>
          {state.canDecide ? (
            <Button variant="secondary" icon="shield-check" onClick={() => setAction('close')}>
              Зафиксировать как закрытый расчёт
            </Button>
          ) : null}
          {state.canRevoke ? (
            <Button variant="danger" icon="ban" onClick={() => setAction('revoke')}>
              Отозвать
            </Button>
          ) : null}
        </div>
      ) : null}
      {state.history.length > 1 ? <p className={styles.muted}>{`Решений по ревизии: ${state.history.length}; история сохраняется.`}</p> : null}
      {action ? (
        <ReasonDialog
          title={action === 'close' ? 'Зафиксировать как закрытый расчёт' : 'Отозвать решение о закрытом расчёте'}
          label="Причина"
          confirmLabel={action === 'close' ? 'Зафиксировать' : 'Отозвать'}
          confirmIcon={action === 'close' ? 'shield-check' : 'ban'}
          minLength={10}
          busy={busy}
          onConfirm={submit}
          onClose={() => setAction(null)}
        >
          <p className={styles.muted}>
            {action === 'close'
              ? 'Решение действует только для этой ревизии. Закрытие у источника (X-01) оно не подтверждает. Новая выгрузка — новая ревизия, не закрытая.'
              : 'Согласование и выпуск комплектов с этим решением будут отказывать. Уже выпущенное не меняется.'}
          </p>
        </ReasonDialog>
      ) : null}
    </div>
  );
};
