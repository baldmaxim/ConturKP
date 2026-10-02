import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { addAxisEvent, createDiscrepancy, decideDiscrepancy } from '../../api/reviewEndpoints';
import type { IFindingDetail, TAxis } from '../../api/reviewTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { TextField } from '../../components/TextField';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { cx } from '../../utils/cx';
import { formatDateTime } from '../../utils/datetime';
import { AXIS_BASIS_HINTS, AXIS_LABELS, AXIS_VALUES } from '../../utils/reviewLabels';
import styles from './Review.module.css';

interface IDiscrepancyPanelProps {
  finding: IFindingDetail;
  onChanged: (next?: IFindingDetail) => void;
}

const AXES: TAxis[] = ['customer_position', 'calculation', 'proposal', 'documents'];

/**
 * Разногласие (I09): позиция заказчика, учёт в расчёте, отражение в КП и закрепление в документах — независимые оси.
 * Каждая меняется своим событием человека с причиной и основанием; поздняя дата письма оси не меняет.
 */
export const DiscrepancyPanel: FC<IDiscrepancyPanelProps> = ({ finding: f, onChanged }) => {
  const [dialog, setDialog] = useState<'create' | 'axis' | 'decision' | null>(null);
  const d = f.discrepancy;
  if (!d) {
    return f.canWrite && !f.restricted ? (
      <div className={styles.toolbar}>
        <Button icon="layers" onClick={() => setDialog('create')}>
          Открыть разногласие
        </Button>
        {dialog === 'create' ? <CreateDialog finding={f} onClose={() => setDialog(null)} onDone={(n) => { setDialog(null); onChanged(n); }} /> : null}
      </div>
    ) : null;
  }
  return (
    <section className={styles.block} aria-label="Разногласие">
      <div className={styles.headLine}>
        <h4 className={styles.sideTitle}>{`Разногласие: ${d.topic}`}</h4>
        {d.restricted ? <Badge label="основания закрыты" icon="lock" tone="muted" /> : null}
      </div>
      <ul className={styles.axes}>
        {AXES.map((axis) => {
          const a = d.axes[axis];
          return (
            <li key={axis} className={cx(styles.axis, a.invalidatedReason && styles.checkGap)}>
              <span className={styles.muted}>{AXIS_LABELS[axis]}</span>
              <span className={styles.axisValue}>{AXIS_VALUES[axis][a.value] ?? a.value}</span>
              <span className={styles.muted}>{a.actor ? `${a.actor}${a.at ? `, ${formatDateTime(a.at)}` : ''}` : 'значение по умолчанию'}</span>
              {a.invalidatedReason ? <Badge label="основание изменилось — подтвердите" icon="clock-alert" tone="warning" dashed /> : null}
            </li>
          );
        })}
      </ul>
      {f.canWrite && !d.restricted ? (
        <div className={styles.toolbar}>
          <Button icon="pencil" onClick={() => setDialog('axis')}>
            Изменить ось
          </Button>
          {f.canDecide ? (
            <Button icon="check" onClick={() => setDialog('decision')}>
              Решение по разногласию
            </Button>
          ) : null}
        </div>
      ) : null}
      {d.decisions.length > 0 ? (
        <ul className={styles.list}>
          {d.decisions.map((x) => (
            <li key={x.id} className={styles.muted}>{`Решение: ${x.statement ?? 'текст скрыт'} · ${x.decidedBy}${x.invalidatedReason ? ` · недействительно: ${x.invalidatedReason}` : ''}`}</li>
          ))}
        </ul>
      ) : null}
      {d.history.length > 0 ? (
        <details className={styles.history}>
          <summary className={styles.summary}>{`История осей: ${d.history.length}`}</summary>
          <ul className={styles.list}>
            {d.history.map((h) => (
              <li key={h.id} className={styles.muted}>
                {`${h.createdAt ? formatDateTime(h.createdAt) : ''} · ${h.actor} · ${AXIS_LABELS[h.axis]}: ${AXIS_VALUES[h.axis][h.value] ?? h.value}${h.reason ? ` · ${h.reason}` : ''}${h.bases.length ? ` · оснований: ${h.bases.length}` : ''}${h.invalidatedReason ? ' · основание изменилось' : ''}`}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {dialog === 'axis' ? <AxisDialog finding={f} onClose={() => setDialog(null)} onDone={(n) => { setDialog(null); onChanged(n); }} /> : null}
      {dialog === 'decision' ? <DecisionDialog finding={f} onClose={() => setDialog(null)} onDone={(n) => { setDialog(null); onChanged(n); }} /> : null}
    </section>
  );
};

const DialogFooter: FC<{ busy: boolean; onClose: () => void; label: string }> = ({ busy, onClose, label }) => (
  <>
    <Button onClick={onClose} disabled={busy}>
      Отмена
    </Button>
    <Button type="submit" variant="primary" icon="check" loading={busy}>
      {label}
    </Button>
  </>
);

const useCommand = (onDone: (next: IFindingDetail) => void) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const run = async (fn: () => Promise<IFindingDetail>, ok: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      toast.push({ kind: 'success', text: ok });
      onDone(next);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
};

const CreateDialog: FC<{ finding: IFindingDetail; onClose: () => void; onDone: (n: IFindingDetail) => void }> = ({ finding, onClose, onDone }) => {
  const [topic, setTopic] = useState('');
  const idem = useIdempotencyKey();
  const cmd = useCommand(onDone);
  return (
    <Dialog
      title="Открыть разногласие"
      onClose={onClose}
      busy={cmd.busy}
      onSubmit={() => (topic.trim() ? void cmd.run(() => createDiscrepancy(finding.id, topic.trim(), idem.keyFor({ id: finding.id, topic })), 'Разногласие открыто') : cmd.setError('Укажите тему'))}
      footer={<DialogFooter busy={cmd.busy} onClose={onClose} label="Открыть" />}
    >
      <TextField label="Тема" value={topic} onValueChange={setTopic} maxLength={300} required placeholder="Например: светильник в коридорах" />
      {cmd.error ? <Notice tone="danger">{cmd.error}</Notice> : null}
    </Dialog>
  );
};

const AxisDialog: FC<{ finding: IFindingDetail; onClose: () => void; onDone: (n: IFindingDetail) => void }> = ({ finding: f, onClose, onDone }) => {
  const [axis, setAxis] = useState<TAxis>('customer_position');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [bases, setBases] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const idem = useIdempotencyKey();
  const cmd = useCommand(onDone);
  const fragments = f.evidence.filter((e) => e.fragment?.readable).map((e) => e.fragment!);
  const submit = (): void => {
    if (!value || !reason.trim()) {
      cmd.setError('Выберите значение и укажите причину');
      return;
    }
    const ids = [...bases, ...extra.split(/[\s,;]+/u).filter((x) => /^[0-9a-f-]{36}$/iu.test(x))];
    void cmd.run(
      () => addAxisEvent(f.discrepancy!.id, { axis, value, reason: reason.trim(), bases: ids.map((id) => ({ type: 'fragment', id })) }, idem.keyFor({ axis, value, reason, ids })),
      'Ось изменена',
    );
  };
  return (
    <Dialog title="Изменить ось разногласия" onClose={onClose} busy={cmd.busy} onSubmit={submit} footer={<DialogFooter busy={cmd.busy} onClose={onClose} label="Записать" />}>
      <SelectField
        label="Ось"
        value={axis}
        onValueChange={(v) => {
          setAxis(v as TAxis);
          setValue('');
        }}
        options={AXES.map((a) => ({ value: a, label: AXIS_LABELS[a] }))}
      />
      <SelectField label="Значение" value={value} onValueChange={setValue} placeholder="Выберите значение" options={Object.entries(AXIS_VALUES[axis]).map(([v, l]) => ({ value: v, label: l }))} hint={AXIS_BASIS_HINTS[value]} />
      <fieldset className={styles.choices}>
        <legend className={styles.sideTitle}>Основания</legend>
        {fragments.map((fr) => (
          <label key={fr.id} className={styles.choice}>
            <input type="checkbox" checked={bases.includes(fr.id)} onChange={(e) => setBases((b) => (e.target.checked ? [...b, fr.id] : b.filter((x) => x !== fr.id)))} />
            <span>{(fr.text ?? '').slice(0, 160)}</span>
          </label>
        ))}
      </fieldset>
      <TextField label="Другие фрагменты (ID цитат)" value={extra} onValueChange={setExtra} hint="Например, ID фрагмента письма из просмотра цитаты" />
      <TextAreaField label="Причина" value={reason} onValueChange={setReason} rows={2} maxLength={2000} required />
      {cmd.error ? <Notice tone="danger">{cmd.error}</Notice> : null}
    </Dialog>
  );
};

const DecisionDialog: FC<{ finding: IFindingDetail; onClose: () => void; onDone: (n: IFindingDetail) => void }> = ({ finding: f, onClose, onDone }) => {
  const [statement, setStatement] = useState('');
  const [rationale, setRationale] = useState('');
  const [choice, setChoice] = useState('');
  const idem = useIdempotencyKey();
  const cmd = useCommand(onDone);
  const facts = f.graphFacts;
  const factValue = (id: string): string => f.evidence.find((e) => e.fact?.id === id)?.fact?.rawValue ?? 'значение';
  const submit = (): void => {
    if (!statement.trim() || !rationale.trim() || (facts && !choice)) {
      cmd.setError(facts ? 'Укажите решение, причину и действующее значение' : 'Укажите решение и причину');
      return;
    }
    const graph = facts ? (choice === 'distinct' ? { kind: 'distinct' as const } : { kind: 'prevails' as const, prevailingFactId: choice }) : null;
    void cmd.run(async () => (await decideDiscrepancy(f.discrepancy!.id, { statement: statement.trim(), rationale: rationale.trim(), graph }, idem.keyFor({ statement, rationale, choice }))).finding, 'Решение записано');
  };
  return (
    <Dialog title="Решение по разногласию" onClose={onClose} busy={cmd.busy} onSubmit={submit} footer={<DialogFooter busy={cmd.busy} onClose={onClose} label="Записать" />}>
      {facts ? (
        <fieldset className={styles.choices}>
          <legend className={styles.sideTitle}>Какое значение действует (решение запишется и в граф фактов)</legend>
          {[...facts.left, ...facts.right].map((id) => (
            <label key={id} className={styles.choice}>
              <input type="radio" name="prevails" checked={choice === id} onChange={() => setChoice(id)} />
              <span>{`Действует «${factValue(id)}»`}</span>
            </label>
          ))}
          <label className={styles.choice}>
            <input type="radio" name="prevails" checked={choice === 'distinct'} onChange={() => setChoice('distinct')} />
            <span>Значения не конфликтуют — это разные условия</span>
          </label>
        </fieldset>
      ) : (
        <Notice tone="info">Стороны не связаны с фактами графа: записывается только решение по разногласию.</Notice>
      )}
      <TextAreaField label="Решение" value={statement} onValueChange={setStatement} rows={2} maxLength={4000} required />
      <TextAreaField label="Причина" value={rationale} onValueChange={setRationale} rows={2} maxLength={4000} required />
      {cmd.error ? <Notice tone="danger">{cmd.error}</Notice> : null}
    </Dialog>
  );
};
