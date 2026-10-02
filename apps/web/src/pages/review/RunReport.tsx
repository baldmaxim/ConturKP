import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { acceptSuggestion, rejectSuggestion } from '../../api/reviewEndpoints';
import type { IRunView, ISuggestionView, TSeverity } from '../../api/reviewTypes';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { cx } from '../../utils/cx';
import { formatDateTime } from '../../utils/datetime';
import { FINDING_STATUS_LABELS, OUTCOME_LABELS, SEVERITY_LABELS, SUMMARY_TONES } from '../../utils/reviewLabels';
import styles from './Review.module.css';

interface IRunReportProps {
  run: IRunView;
  canWrite: boolean;
  onChanged: () => void;
  onOpenFindings: () => void;
}

const COUNT_LABELS: Record<string, string> = {
  units: 'единиц снимка',
  documents: 'документов',
  gaps: 'пробелов',
  pagesMissing: 'непрочитанных страниц',
  importsPending: 'элементов импорта без исхода',
  requirements: 'требований',
  fragments: 'фрагментов',
  unreviewed: 'не просмотрено',
  findings: 'замечаний',
  unassessed: 'без оценки покрытия',
  needsReview: 'требуют пересмотра',
  complexRate: 'комплексных расценок',
  checked: 'сравнений',
  missingObjects: 'объектов покрытия не найдено',
  compared: 'сравнено единиц',
  explained: 'расхождений с пояснением',
  positions: 'позиций',
  duplicates: 'групп дублей',
  contractRequirements: 'обязательств договора',
  matched: 'фраз неопределённости',
  factConflicts: 'конфликтов фактов',
  facts: 'фактов',
  factsPendingUnits: 'единиц без фактов',
  unanswered: 'вопросов без ответа',
  hypotheses: 'гипотез',
  dropped: 'отброшено ссылок вне входа',
  batches: 'пачек модели',
  restricted: 'требований с недоступными цитатами',
  invalidOutputs: 'невалидных ответов',
};

const countsText = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .filter(([k, v]) => typeof v === 'number' && v > 0 && COUNT_LABELS[k] && k !== 'passCompleted')
    .map(([k, v]) => `${COUNT_LABELS[k]}: ${v}`)
    .join(' · ');

/** Отчёт прогона: сводка без ложного «всё проверено», устаревание с причинами, исходы проверок, гипотезы модели. */
export const RunReport: FC<IRunReportProps> = ({ run, canWrite, onChanged, onOpenFindings }) => {
  const [accepting, setAccepting] = useState<ISuggestionView | null>(null);
  const [rejecting, setRejecting] = useState<ISuggestionView | null>(null);
  const rules = run.checks.filter((c) => c.method === 'rule');
  const model = run.checks.filter((c) => c.method === 'model');
  const byStatus = Object.entries(run.findings.byStatus).filter(([, n]) => (n ?? 0) > 0);

  return (
    <div className={styles.stack}>
      <Notice tone={SUMMARY_TONES[run.summary.kind]}>{run.summary.text}</Notice>
      {run.freshness.outdated ? (
        <Notice tone="warning">
          {`Отчёт сохранён как был, но устарел: ${run.freshness.reasons.join('; ')}. Нужна повторная проверка на новом снимке.`}
        </Notice>
      ) : null}
      {run.freshness.events.length > 0 ? (
        <details className={styles.history}>
          <summary className={styles.summary}>{`События после снимка: ${run.freshness.events.length}`}</summary>
          <ul className={styles.list}>
            {run.freshness.events.map((e) => (
              <li key={e.seq} className={styles.muted}>{`№ ${e.seq} · ${e.at ? formatDateTime(e.at) : ''} · ${e.reason ?? e.type}${e.mode === 'conservative' ? ' · консервативно' : ''}`}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <section className={styles.block} aria-label="Замечания прогона">
        <div className={styles.headLine}>
          <h3 className={styles.blockTitle}>Замечания</h3>
          {byStatus.map(([status, n]) => (
            <Badge key={status} {...FINDING_STATUS_LABELS[status as keyof typeof FINDING_STATUS_LABELS]} label={`${FINDING_STATUS_LABELS[status as keyof typeof FINDING_STATUS_LABELS].label}: ${n}`} />
          ))}
          <Button icon="list-checks" className={styles.push} onClick={onOpenFindings}>
            К разногласиям
          </Button>
        </div>
      </section>

      <section className={styles.block} aria-label="Программные проверки">
        <h3 className={styles.blockTitle}>Программные проверки</h3>
        <ul className={styles.checks}>
          {rules.map((c) => (
            <li key={c.code} className={cx(styles.check, (c.outcome === 'incomplete' || c.outcome === 'error' || c.outcome === null) && styles.checkGap)}>
              <div className={styles.headLine}>
                <span className={styles.title}>{c.title}</span>
                {c.outcome ? <Badge {...OUTCOME_LABELS[c.outcome]} /> : <Badge label="нет итога" icon="hourglass" tone="info" dashed />}
              </div>
              {c.reason ? <p className={styles.text}>{c.reason}</p> : null}
              {countsText(c.counts) ? <p className={styles.muted}>{countsText(c.counts)}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.block} aria-label="Гипотезы модели">
        <h3 className={styles.blockTitle}>Гипотезы модели</h3>
        {model.map((c) => (
          <div key={c.code} className={cx(styles.check, (c.outcome === 'incomplete' || c.outcome === 'error' || c.outcome === null) && styles.checkGap)}>
            <div className={styles.headLine}>
              <span className={styles.title}>{c.title}</span>
              {c.outcome ? <Badge {...OUTCOME_LABELS[c.outcome]} /> : <Badge label="нет итога" icon="hourglass" tone="info" dashed />}
            </div>
            {c.reason ? <p className={styles.text}>{c.reason}</p> : null}
            {countsText(c.counts) ? <p className={styles.muted}>{countsText(c.counts)}</p> : null}
          </div>
        ))}
        {run.suggestions.length === 0 ? (
          <p className={styles.muted}>Гипотез нет.</p>
        ) : (
          <ul className={styles.list}>
            {run.suggestions.map((s) => (
              <li key={s.id} className={styles.card}>
                <div className={styles.headLine}>
                  <Badge label="гипотеза модели" icon="file-question-mark" tone="info" dashed />
                  <Badge
                    label={{ open: 'ждёт решения', accepted: 'принята', rejected: 'отклонена', expired: 'истекла' }[s.status]}
                    icon={s.status === 'accepted' ? 'check' : s.status === 'open' ? 'hourglass' : 'circle-x'}
                    tone={s.status === 'accepted' ? 'success' : s.status === 'open' ? 'warning' : 'muted'}
                  />
                </div>
                <p className={styles.title}>{s.title}</p>
                {s.rationale ? <p className={styles.muted}>{s.rationale}</p> : null}
                {s.evidence.filter((e) => e.fragmentId).map((e) => (
                  <AppLink key={`${e.side}:${e.fragmentId}`} to={`/evidence/${e.fragmentId}`}>
                    {e.side === 'left' ? 'Цитата требования' : 'Цитата'}
                  </AppLink>
                ))}
                {s.decidedBy ? <p className={styles.muted}>{`Решил: ${s.decidedBy}${s.decisionReason ? ` · ${s.decisionReason}` : ''}`}</p> : null}
                {canWrite && s.status === 'open' && !s.restricted ? (
                  <div className={styles.toolbar}>
                    <Button icon="check" onClick={() => setAccepting(s)}>
                      Принять как замечание
                    </Button>
                    <Button variant="ghost" icon="x" onClick={() => setRejecting(s)}>
                      Отклонить
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className={styles.history}>
        <summary className={styles.summary}>Закреплённые входы</summary>
        <dl className={styles.meta}>
          <dt>Снимок области</dt>
          <dd className={styles.mono}>{run.inputs.evidenceScopeId}</dd>
          <dt>Реестр</dt>
          <dd className={styles.mono}>{run.inputs.registryId ?? 'нет'}</dd>
          <dt>Ревизия расчёта</dt>
          <dd className={styles.mono}>{run.inputs.calculationRevisionId ?? 'нет'}</dd>
          <dt>Версия входов</dt>
          <dd>{`снимок — ${run.inputs.scopeInputVersion}, запуск — ${run.inputs.stageInputVersion}`}</dd>
          <dt>Правила</dt>
          <dd className={styles.mono}>{`${run.inputs.rulesVersion} · ${run.inputs.rulesSha256.slice(0, 12)}`}</dd>
          <dt>Промпт модели</dt>
          <dd className={styles.mono}>{run.inputs.promptVersion ? `${run.inputs.promptVersion} · ${run.inputs.promptSha256?.slice(0, 12)}` : 'модель не настроена'}</dd>
          <dt>Приоритет источников</dt>
          <dd>
            <ol className={styles.priority}>
              {run.inputs.priority.map((p) => (
                <li key={p.kind}>{p.title}</li>
              ))}
            </ol>
          </dd>
        </dl>
      </details>

      {accepting ? <AcceptDialog suggestion={accepting} onClose={() => setAccepting(null)} onDone={() => { setAccepting(null); onChanged(); }} /> : null}
      {rejecting ? <RejectDialog suggestion={rejecting} onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); onChanged(); }} /> : null}
    </div>
  );
};

const AcceptDialog: FC<{ suggestion: ISuggestionView; onClose: () => void; onDone: () => void }> = ({ suggestion, onClose, onDone }) => {
  const [severity, setSeverity] = useState<TSeverity>('minor');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();
  const toast = useToast();
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await acceptSuggestion(suggestion.id, { severity, reason: reason.trim() || null }, idem.keyFor({ id: suggestion.id, severity, reason }));
      toast.push({ kind: 'success', text: 'Гипотеза принята: создано замечание' });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Принять гипотезу как замечание"
      onClose={onClose}
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" icon="check" loading={busy}>
            Принять
          </Button>
        </>
      }
    >
      <p className={styles.text}>{suggestion.title}</p>
      <SelectField
        label="Критичность"
        value={severity}
        onValueChange={(v) => setSeverity(v as TSeverity)}
        options={(['minor', 'major', 'critical'] as const).map((v) => ({ value: v, label: SEVERITY_LABELS[v].label }))}
        hint="Критичность гипотезы выбирает человек (таблица D-029)"
      />
      <TextAreaField label="Комментарий" value={reason} onValueChange={setReason} rows={2} maxLength={2000} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
};

const RejectDialog: FC<{ suggestion: ISuggestionView; onClose: () => void; onDone: () => void }> = ({ suggestion, onClose, onDone }) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();
  const submit = async (): Promise<void> => {
    if (!reason.trim()) {
      setError('Укажите причину');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rejectSuggestion(suggestion.id, reason.trim(), idem.keyFor({ id: suggestion.id, reason }));
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Отклонить гипотезу"
      onClose={onClose}
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" icon="x" loading={busy}>
            Отклонить
          </Button>
        </>
      }
    >
      <p className={styles.text}>{suggestion.title}</p>
      <TextAreaField label="Причина" value={reason} onValueChange={setReason} rows={2} maxLength={2000} required />
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
};
