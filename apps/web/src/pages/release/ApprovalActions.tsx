import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { approveCandidate, releaseCandidate, returnCandidate, revokeApproval } from '../../api/releaseEndpoints';
import type { ICandidateView } from '../../api/releaseTypes';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { TextAreaField } from '../../components/TextAreaField';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { BLOCKER_TITLES, formatBytes, MODE_LABEL } from '../../utils/releaseLabels';
import { ReasonDialog } from './ReasonDialog';
import styles from './Approval.module.css';

type TDialog = 'approve' | 'release' | 'return' | 'revoke' | null;

/** Точный состав комплекта в диалоге подтверждения (BRAND.md §9.1 п. 5): что именно согласуется или выпускается. */
const Composition: FC<{ c: ICandidateView; verb: string }> = ({ c, verb }) => {
  const gate = c.status === 'approved' ? c.gate?.release : c.gate?.approve;
  const accepted = (gate?.blockers ?? []).flatMap((b) => b.items.filter((i) => i.acceptance).map((i) => ({ code: b.code, title: i.title, reason: i.acceptance!.reason })));
  const review = c.gate?.warnings?.reviewRisks ?? [];
  return (
    <div className={styles.composition}>
      <p className={styles.muted}>{`${verb} именно это содержимое: SHA-256 манифеста ${c.contentHash?.slice(0, 16)}…`}</p>
      <ul className={styles.compList}>
        <li>{`Режим: ${MODE_LABEL[c.mode] ?? c.mode}${c.mode === 'test' ? ' — отправка заказчику невозможна' : ''}`}</li>
        {c.inputs ? <li>{`Расчёт: ревизия № ${c.inputs.calculationRevision.seq} (${c.inputs.calculationRevision.kind === 'provisional' ? 'предварительная' : 'подтверждённая'})`}</li> : null}
        {c.inputs ? <li>{c.inputs.reviewRun ? `Прогон проверок: ${c.inputs.reviewRun.status === 'completed' ? 'завершён' : 'завершён с пробелами'}` : 'Прогона проверок нет'}</li> : null}
        {(c.inputs?.drafts ?? []).map((d) => (
          <li key={d.id}>{`«${d.title}»: шаблон «${d.templateName}», ревизия № ${d.revisionSeq}${d.isDemo ? ' (демо)' : ''}`}</li>
        ))}
      </ul>
      <h5 className={styles.compTitle}>Файлы</h5>
      <ul className={styles.compList}>
        {(c.files ?? []).map((f) => (
          <li key={f.id} className={styles.compFile}>
            <span>{`${f.audience === 'customer' ? 'Заказчику' : 'Внутреннее'}: ${f.path}`}</span>
            <span className={styles.mono}>{`${formatBytes(f.sizeBytes)} · ${f.sha256.slice(0, 12)}…`}</span>
          </li>
        ))}
      </ul>
      {accepted.length > 0 || review.length > 0 ? (
        <>
          <h5 className={styles.compTitle}>Принятые риски</h5>
          <ul className={styles.compList}>
            {accepted.map((a, n) => (
              <li key={`a${n}`}>{`${BLOCKER_TITLES[a.code] ?? a.code}: ${a.title} — ${a.reason}`}</li>
            ))}
            {review.map((r) => (
              <li key={r.findingId}>{`Замечание «${r.title}» (риск принят на проверке${r.acceptedBy ? `, ${r.acceptedBy}` : ''}): ${r.reason}`}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
};

interface IApprovalActionsProps {
  c: ICandidateView;
  onChanged: () => void;
}

/**
 * Зона действий в конце карточки (BRAND.md §9.1): «Согласовать…» — руководителю, «Выпустить…» — инженеру после
 * согласования; «Вернуть на доработку…» и «Отозвать согласование…» — вторичные, отделены промежутком. Кнопку видит
 * только тот, у кого есть полномочия; при блокерах она недоступна, причины — рядом. Проверяет всё равно сервер.
 */
export const ApprovalActions: FC<IApprovalActionsProps> = ({ c, onChanged }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const [dialog, setDialog] = useState<TDialog>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const can = c.can ?? { approve: false, acceptRisk: false, resolveHolds: false, release: false };
  const run = (p: Promise<unknown>, ok: string): void => {
    setBusy(true);
    p.then(
      () => {
        idem.reset();
        setBusy(false);
        setDialog(null);
        setComment('');
        toast.push({ kind: 'success', text: ok });
        onChanged();
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
        onChanged();
      },
    );
  };
  const ready = c.status === 'ready_for_approval';
  const approved = c.status === 'approved';
  if (!ready && !approved) return null;
  const approveGate = c.gate?.approve ?? null;
  const releaseGate = c.gate?.release ?? null;
  const reasons = (g: typeof approveGate) => (g?.blockers ?? []).filter((b) => b.open > 0).map((b) => `${BLOCKER_TITLES[b.code] ?? b.code}${b.open > 1 ? ` (${b.open})` : ''}`);
  const blocked = ready ? reasons(approveGate) : reasons(releaseGate);
  return (
    <div className={styles.actionBar} role="region" aria-label="Согласование и выпуск" data-bottom-bar="true">
      {blocked.length > 0 && ((ready && can.approve) || (approved && can.release)) ? <p className={styles.reasons}>{`Недоступно: ${blocked.join('; ')}`}</p> : null}
      <div className={styles.actionRow}>
        {ready ? (
          can.approve ? (
            <>
              <Button variant="primary" icon="stamp" disabled={blocked.length > 0} onClick={() => setDialog('approve')}>
                Согласовать…
              </Button>
              <span className={styles.gap} aria-hidden="true" />
              <Button variant="secondary" icon="undo-2" onClick={() => setDialog('return')}>
                Вернуть на доработку…
              </Button>
            </>
          ) : (
            <p className={styles.muted}>Согласует руководитель тендера.</p>
          )
        ) : null}
        {approved ? (
          <>
            {can.release ? (
              <Button variant="primary" icon="package-check" disabled={blocked.length > 0} onClick={() => setDialog('release')}>
                Выпустить…
              </Button>
            ) : (
              <p className={styles.muted}>Выпускает инженер тендера.</p>
            )}
            {can.approve && c.approval ? (
              <>
                <span className={styles.gap} aria-hidden="true" />
                <Button variant="secondary" icon="undo-2" onClick={() => setDialog('revoke')}>
                  Отозвать согласование…
                </Button>
              </>
            ) : null}
          </>
        ) : null}
      </div>
      {dialog === 'approve' ? (
        <ConfirmDialog
          title={`Согласовать комплект № ${c.seq}?`}
          confirmLabel={`Согласовать комплект № ${c.seq}`}
          confirmIcon="stamp"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={() => run(approveCandidate(c, comment.trim() || null, idem.keyFor({ a: c.id, comment })), `Комплект № ${c.seq} согласован`)}
        >
          <Composition c={c} verb="Согласуется" />
          <TextAreaField label="Комментарий (необязательно)" value={comment} onValueChange={setComment} rows={2} maxLength={2000} />
        </ConfirmDialog>
      ) : null}
      {dialog === 'release' && c.approval ? (
        <ConfirmDialog
          title={`Выпустить комплект № ${c.seq}?`}
          confirmLabel={`Выпустить комплект № ${c.seq}`}
          confirmIcon="package-check"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={() => run(releaseCandidate(c, c.approval!.id, idem.keyFor({ r: c.id, a: c.approval!.id })), `Комплект № ${c.seq} выпущен`)}
        >
          <Composition c={c} verb="Выпускается" />
          <p className={styles.muted}>{`Согласовал ${c.approval.approvedBy.name}. Файлы выпуска — точные байты этого комплекта, заново не генерируются.`}</p>
        </ConfirmDialog>
      ) : null}
      {dialog === 'return' ? (
        <ReasonDialog
          title={`Вернуть комплект № ${c.seq} на доработку`}
          label="Что исправить"
          confirmLabel="Вернуть на доработку"
          confirmIcon="undo-2"
          busy={busy}
          onConfirm={(reason) => run(returnCandidate(c, reason, idem.keyFor({ ret: c.id, reason })), 'Комплект возвращён на доработку')}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'revoke' && c.approval ? (
        <ReasonDialog
          title="Отозвать согласование"
          label="Причина отзыва"
          confirmLabel="Отозвать согласование"
          confirmIcon="undo-2"
          busy={busy}
          onConfirm={(reason) => run(revokeApproval(c.approval!, reason, idem.keyFor({ rev: c.approval!.id, reason })), 'Согласование отозвано: комплект снова ждёт согласования')}
          onClose={() => setDialog(null)}
        >
          <p className={styles.muted}>Отозванное согласование остаётся в истории. После выпуска отзыв невозможен.</p>
        </ReasonDialog>
      ) : null}
    </div>
  );
};
