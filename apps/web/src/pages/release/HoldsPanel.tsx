import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { listHolds, resolveHolds } from '../../api/releaseEndpoints';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { EVENT_LABELS, HOLD_STATUS } from '../../utils/releaseLabels';
import { ReasonDialog } from './ReasonDialog';
import styles from './Approval.module.css';

interface IHoldsPanelProps {
  stageId: string;
  candidateId: string;
  version: string;
  onChanged: () => void;
}

/**
 * Удержания комплекта (D-033 В-13-5): события после сборки или не вошедшие в снимок, которые останавливают согласование,
 * выпуск или отправку до решения руководителя. «Не влияет» снимает удержание только по выбранным событиям; «влияет» —
 * невыпущенный комплект возвращается, у выпущенного отправка исключена. Прежнее согласование остаётся в истории.
 * Событие с закрытым для пользователя предметом (письмо чужого ящика) показывается без причины и не выбирается: решение
 * о применимости принимает тот, кто может прочитать предмет (R13-02).
 */
export const HoldsPanel: FC<IHoldsPanelProps> = ({ stageId, candidateId, version, onChanged }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const res = useApiResource((signal) => listHolds(stageId, candidateId, signal), `holds:${candidateId}:${version}`);
  const [chosen, setChosen] = useState<string[]>([]);
  const [dialog, setDialog] = useState<'not_applicable' | 'requires_new_candidate' | null>(null);
  const [busy, setBusy] = useState(false);
  const items = res.data?.items ?? [];
  if (items.length === 0) return null;
  const open = items.filter((h) => h.status === 'open' && !h.covered);
  const decidable = open.filter((h) => !h.restricted);
  const canResolve = res.data?.canResolve ?? false;
  const selected = chosen.filter((id) => decidable.some((h) => h.id === id));
  const submit = (reason: string): void => {
    if (!dialog) return;
    const body = { holdIds: selected, resolution: dialog, reason };
    setBusy(true);
    resolveHolds(candidateId, body, idem.keyFor(body)).then(
      () => {
        idem.reset();
        setBusy(false);
        setDialog(null);
        setChosen([]);
        res.reload();
        onChanged();
        toast.push({ kind: 'success', text: dialog === 'not_applicable' ? 'Решение записано: события не влияют на комплект' : 'Решение записано: нужен новый комплект' });
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
      },
    );
  };
  return (
    <section className={styles.holds} aria-label="Удержания по событиям">
      <h4 className={styles.gateTitle}>{open.length > 0 ? `Ждут решения руководителя: ${open.length}` : 'Решения по событиям'}</h4>
      <ul className={styles.items}>
        {items.map((h) => {
          const st = h.covered && h.status === 'open' ? { label: 'Учтено составом', icon: 'check' as const, tone: 'muted' as const } : HOLD_STATUS[h.status]!;
          const pending = h.status === 'open' && !h.covered;
          return (
            <li key={h.id} className={styles.holdRow}>
              {canResolve && pending && !h.restricted ? (
                <input
                  type="checkbox"
                  className={styles.check}
                  aria-label={`Выбрать событие № ${h.event.seq}`}
                  checked={chosen.includes(h.id)}
                  onChange={() => setChosen((x) => (x.includes(h.id) ? x.filter((y) => y !== h.id) : [...x, h.id]))}
                />
              ) : null}
              <div className={styles.holdText}>
                <span className={styles.label}>{`№ ${h.event.seq}: ${EVENT_LABELS[h.event.type] ?? h.event.type}`}</span>
                <span className={styles.muted}>{h.event.at ? formatDateTime(h.event.at) : ''}</span>
                {h.reason ? <span className={styles.muted}>{`${h.resolvedBy?.name ?? ''}, ${h.resolvedAt ? formatDateTime(h.resolvedAt) : ''}: ${h.reason}`}</span> : null}
                {h.restricted ? (
                  <span className={styles.muted}>
                    {h.status === 'open'
                      ? 'Предмет события закрыт для вас: решение принимает тот, кто может его прочитать'
                      : `${h.resolvedBy?.name ?? ''}, ${h.resolvedAt ? formatDateTime(h.resolvedAt) : ''}: причина закрыта вместе с предметом события`}
                  </span>
                ) : null}
              </div>
              <Badge label={st.label} icon={st.icon} tone={st.tone} />
            </li>
          );
        })}
      </ul>
      {canResolve && decidable.length > 0 ? (
        <div className={styles.holdActions}>
          <Button variant="secondary" onClick={() => setChosen(selected.length === decidable.length ? [] : decidable.map((h) => h.id))}>
            {selected.length === decidable.length ? 'Снять выбор' : 'Выбрать все'}
          </Button>
          <Button variant="secondary" icon="check" disabled={selected.length === 0} onClick={() => setDialog('not_applicable')}>
            Не влияет…
          </Button>
          <Button variant="secondary" icon="undo-2" disabled={selected.length === 0} onClick={() => setDialog('requires_new_candidate')}>
            Влияет…
          </Button>
        </div>
      ) : open.length > 0 && !canResolve ? (
        <p className={styles.muted}>Решение о применимости принимает руководитель тендера.</p>
      ) : null}
      {dialog ? (
        <ReasonDialog
          title={dialog === 'not_applicable' ? `Не влияет: событий — ${selected.length}` : `Влияет: событий — ${selected.length}`}
          label="Основание решения"
          confirmLabel={dialog === 'not_applicable' ? 'Записать «не влияет»' : 'Записать «влияет»'}
          confirmIcon={dialog === 'not_applicable' ? 'check' : 'undo-2'}
          busy={busy}
          onConfirm={submit}
          onClose={() => setDialog(null)}
        >
          <p className={styles.muted}>
            {dialog === 'not_applicable'
              ? 'Удержание снимается только по выбранным событиям. Права, целостность файлов, актуальность оснований и ограничения боевого выпуска проверяются по-прежнему.'
              : 'Невыпущенный комплект вернётся на доработку, его согласование будет отозвано. У выпущенного отправка будет исключена навсегда.'}
          </p>
        </ReasonDialog>
      ) : null}
    </section>
  );
};
