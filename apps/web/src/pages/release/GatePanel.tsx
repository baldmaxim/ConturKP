import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { acceptRisk } from '../../api/releaseEndpoints';
import type { IGateBlocker, IGateItem, IGateView } from '../../api/releaseTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { BLOCKER_CLASS, BLOCKER_TITLES } from '../../utils/releaseLabels';
import { ReasonDialog } from './ReasonDialog';
import styles from './Approval.module.css';

interface IGatePanelProps {
  candidateId: string;
  gate: IGateView;
  title: string;
  canAcceptRisk: boolean;
  onChanged: () => void;
}

/**
 * Матрица блокеров действия (D-033): что запрещает согласование или выпуск. Неснимаемые блокеры (полномочия, технические,
 * целостность) — только исправлением; бизнес-пункты руководитель снимает принятием риска с причиной. Принятый риск
 * остаётся виден с автором и причиной — он не «пройдено» и не закрывает вопрос или замечание.
 */
export const GatePanel: FC<IGatePanelProps> = ({ candidateId, gate, title, canAcceptRisk, onChanged }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const [target, setTarget] = useState<{ b: IGateBlocker; i: IGateItem } | null>(null);
  const [busy, setBusy] = useState(false);
  const accept = (reason: string): void => {
    if (!target) return;
    const body = { blockerCode: target.b.code, subjectType: target.i.subjectType, subjectId: target.i.subjectId, subjectKey: target.i.subjectKey, reason };
    setBusy(true);
    acceptRisk(candidateId, body, idem.keyFor(body)).then(
      () => {
        idem.reset();
        setBusy(false);
        setTarget(null);
        toast.push({ kind: 'success', text: 'Риск принят: пункт остаётся видимым с причиной' });
        onChanged();
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
      },
    );
  };
  return (
    <section className={styles.gate} aria-label={title}>
      <h4 className={styles.gateTitle}>{gate.ok ? `${title}: блокеров нет` : `${title}: что мешает`}</h4>
      {gate.blockers.length === 0 ? <p className={styles.muted}>Матрица выпуска не находит блокеров. Окончательно проверяет сервер при действии.</p> : null}
      <ul className={styles.blockers}>
        {gate.blockers.map((b) => (
          <li key={b.code} className={styles.blocker} data-open={b.open > 0 ? 'true' : 'false'}>
            <div className={styles.blockerHead}>
              <Badge
                label={b.open > 0 ? (b.acceptable ? 'Снимается принятием риска' : 'Риском не снимается') : 'Риск принят'}
                icon={b.open > 0 ? (b.acceptable ? 'info' : 'ban') : 'shield-check'}
                tone={b.open > 0 ? (b.acceptable ? 'warning' : 'danger') : 'accent'}
              />
              <span className={styles.label}>{BLOCKER_TITLES[b.code] ?? b.code}</span>
              <span className={styles.muted}>{`${BLOCKER_CLASS[b.class] ?? b.class} · ${b.code}`}</span>
            </div>
            <ul className={styles.items}>
              {b.items.map((i) => (
                <li key={`${i.subjectType}:${i.subjectId}:${i.subjectKey}`} className={styles.blockerItem}>
                  <span className={styles.itemText}>{i.title}</span>
                  {i.acceptance ? (
                    <span className={styles.muted}>
                      {`Риск принят: ${i.acceptance.acceptedBy}, ${formatDateTime(i.acceptance.acceptedAt)} — ${i.acceptance.reason ?? 'причина закрыта вместе с основаниями пункта'}`}
                    </span>
                  ) : canAcceptRisk && i.acceptable && !i.restricted ? (
                    <Button variant="secondary" icon="shield-check" onClick={() => setTarget({ b, i })}>
                      Принять риск…
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {target ? (
        <ReasonDialog
          title="Принять риск"
          label="Причина принятия риска"
          confirmLabel="Принять риск"
          confirmIcon="shield-check"
          minLength={10}
          busy={busy}
          onConfirm={accept}
          onClose={() => setTarget(null)}
        >
          <p className={styles.muted}>{`${BLOCKER_TITLES[target.b.code] ?? target.b.code}: ${target.i.title}`}</p>
          <p className={styles.muted}>Пункт останется видимым с вашей причиной; вопрос, замечание или поле не закрываются. Принятие действует только для этого комплекта.</p>
        </ReasonDialog>
      ) : null}
    </section>
  );
};
