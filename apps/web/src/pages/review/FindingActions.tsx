import { useState, type FC } from 'react';
import { listMembers } from '../../api/endpoints';
import { describeError } from '../../api/errors';
import { patchFinding, transitionFinding } from '../../api/reviewEndpoints';
import type { IFindingDetail, TConfidence, TSeverity } from '../../api/reviewTypes';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { CONFIDENCE_LABELS, SEVERITY_LABELS } from '../../utils/reviewLabels';
import styles from './Review.module.css';

type TAction = 'in_progress' | 'resolved' | 'accepted_risk' | 'rejected' | 'open' | 'edit';

interface IFindingActionsProps {
  finding: IFindingDetail;
  tenderId: string;
  onChanged: (next?: IFindingDetail) => void;
}

const TITLES: Record<TAction, string> = {
  in_progress: 'Взять в работу',
  resolved: 'Решить замечание',
  accepted_risk: 'Принять риск',
  rejected: 'Отклонить замечание',
  open: 'Открыть снова',
  edit: 'Критичность, действие, ответственный',
};

/** Действия человека над замечанием (state-machines §10): решение — с формулировкой; риск — руководитель (D-029 В-09-3). */
export const FindingActions: FC<IFindingActionsProps> = ({ finding: f, tenderId, onChanged }) => {
  const [action, setAction] = useState<TAction | null>(null);
  if (!f.canWrite || f.restricted) return null;
  const can = (to: string): boolean =>
    ({ open: ['in_progress', 'resolved', 'accepted_risk', 'rejected'], in_progress: ['resolved', 'accepted_risk', 'rejected'], stale: ['open'] } as Record<string, string[]>)[f.status]?.includes(to) ?? false;
  return (
    <div className={styles.toolbar}>
      {can('in_progress') ? (
        <Button icon="user-check" onClick={() => setAction('in_progress')}>
          В работу
        </Button>
      ) : null}
      {can('resolved') ? (
        <Button icon="check" variant="primary" onClick={() => setAction('resolved')}>
          Решить
        </Button>
      ) : null}
      {can('accepted_risk') && f.canAcceptRisk && f.riskAcceptable ? (
        <Button icon="shield-x" onClick={() => setAction('accepted_risk')}>
          Принять риск
        </Button>
      ) : null}
      {can('rejected') ? (
        <Button variant="ghost" icon="circle-x" onClick={() => setAction('rejected')}>
          Не проблема
        </Button>
      ) : null}
      {can('open') ? (
        <Button icon="repeat" onClick={() => setAction('open')}>
          Пересмотреть
        </Button>
      ) : null}
      {f.status !== 'stale' ? (
        <Button variant="ghost" icon="pencil" onClick={() => setAction('edit')}>
          Изменить
        </Button>
      ) : null}
      {can('accepted_risk') && !f.riskAcceptable ? <span className={styles.muted}>Техническое замечание: риском не принимается, только решается.</span> : null}
      {action ? <ActionDialog finding={f} tenderId={tenderId} action={action} onClose={() => setAction(null)} onDone={(next) => { setAction(null); onChanged(next); }} /> : null}
    </div>
  );
};

const ActionDialog: FC<{ finding: IFindingDetail; tenderId: string; action: TAction; onClose: () => void; onDone: (next: IFindingDetail) => void }> = ({ finding: f, tenderId, action, onClose, onDone }) => {
  const members = useApiResource((signal) => (action === 'in_progress' || action === 'edit' ? listMembers(tenderId, signal) : Promise.resolve(null)), `${tenderId}:${action}`);
  const [statement, setStatement] = useState('');
  const [reason, setReason] = useState('');
  const [owner, setOwner] = useState(f.owner?.id ?? '');
  const [severity, setSeverity] = useState<TSeverity>(f.severity);
  const [confidence, setConfidence] = useState<TConfidence>(f.confidence);
  const [act, setAct] = useState(f.action ?? '');
  const [impact, setImpact] = useState(f.impact ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();
  const toast = useToast();
  const needsStatement = action === 'resolved' || action === 'accepted_risk';
  const needsReason = action === 'resolved' || action === 'accepted_risk' || action === 'rejected';

  const submit = async (): Promise<void> => {
    if ((needsStatement && !statement.trim()) || (needsReason && !reason.trim()) || (action === 'in_progress' && !owner)) {
      setError(action === 'in_progress' ? 'Выберите ответственного' : 'Заполните обязательные поля');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next =
        action === 'edit'
          ? await patchFinding(
              f,
              { severity, confidence, ownerUserId: owner || null, action: act.trim() || null, impact: impact.trim() || null, reason: reason.trim() || null },
              idem.keyFor({ id: f.id, severity, confidence, owner, act, impact }),
            )
          : await transitionFinding(
              f,
              { to: action, reason: reason.trim() || null, statement: statement.trim() || null, ...(action === 'in_progress' ? { ownerUserId: owner } : {}) },
              idem.keyFor({ id: f.id, action, statement, reason, owner }),
            );
      toast.push({ kind: 'success', text: action === 'edit' ? 'Замечание обновлено' : 'Статус замечания изменён' });
      onDone(next);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const memberOptions = [{ value: '', label: 'Не назначен' }, ...(members.data?.items ?? []).map((m) => ({ value: m.userId, label: m.displayName }))];
  return (
    <Dialog
      title={TITLES[action]}
      onClose={onClose}
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" icon="check" loading={busy}>
            Записать
          </Button>
        </>
      }
    >
      <p className={styles.text}>{f.title}</p>
      {action === 'accepted_risk' ? <Notice tone="info">Принятый риск остаётся видимым с автором и причиной; критичность и статусы согласования не меняются.</Notice> : null}
      {action === 'in_progress' || action === 'edit' ? <SelectField label="Ответственный" value={owner} onValueChange={setOwner} options={memberOptions} /> : null}
      {action === 'edit' ? (
        <>
          <SelectField
            label="Критичность"
            value={severity}
            onValueChange={(v) => setSeverity(v as TSeverity)}
            options={(['critical', 'major', 'minor'] as const).map((v) => ({ value: v, label: SEVERITY_LABELS[v].label }))}
            hint="«Критичное» ставит только человек"
          />
          <SelectField label="Уверенность" value={confidence} onValueChange={(v) => setConfidence(v as TConfidence)} options={(['low', 'medium', 'high'] as const).map((v) => ({ value: v, label: CONFIDENCE_LABELS[v] }))} />
          <TextAreaField label="Действие" value={act} onValueChange={setAct} rows={2} maxLength={1000} />
          <TextAreaField label="Влияние на КП" value={impact} onValueChange={setImpact} rows={2} maxLength={1000} />
        </>
      ) : null}
      {needsStatement ? <TextAreaField label={action === 'resolved' ? 'Решение' : 'Что принимается как риск'} value={statement} onValueChange={setStatement} rows={2} maxLength={4000} required /> : null}
      {needsReason || action === 'open' || action === 'edit' ? (
        <TextAreaField label="Причина" value={reason} onValueChange={setReason} rows={2} maxLength={2000} required={needsReason} />
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
};
