import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { completeDraft, getDraft, listSuggestionRuns, migrateDraft, startSuggestionRun } from '../../api/formsEndpoints';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import { CHANGE_LABEL } from '../../utils/formsLabels';
import form from '../../styles/form.module.css';
import { FieldCard } from './FieldCard';
import { IssuesList } from './IssuesList';
import styles from './Forms.module.css';

interface IDraftWizardProps {
  draftId: string;
  canAskCustomer: boolean;
  onOpenDraft: (id: string) => void;
  onChanged: () => void;
}

const DRAFT_STATUS: Record<string, { label: string; tone: 'success' | 'info' | 'muted' }> = {
  in_progress: { label: 'В работе', tone: 'info' },
  complete: { label: 'Заполнено', tone: 'success' },
  superseded: { label: 'Заменено переносом', tone: 'muted' },
};

/**
 * Веб-мастер заполнения приложения (этап 11, D-031): разделы — шаги, поля с быстрыми действиями, список
 * незавершённых пунктов с переходом к полю, «заполнено» только без блокирующих пунктов, перенос на новую ревизию
 * шаблона. Демонстрационная форма помечена баннером и к выпуску не допускается.
 */
export const DraftWizard: FC<IDraftWizardProps> = ({ draftId, canAskCustomer, onOpenDraft, onChanged }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const draft = useApiResource((signal) => getDraft(draftId, signal), draftId);
  const runs = useApiResource((signal) => listSuggestionRuns(draftId, signal), draftId);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const active = (runs.data?.items ?? []).some((r) => r.status === 'queued' || r.status === 'running');
  usePolling(active, () => {
    runs.reload();
    draft.reload();
  }, 2500);
  if (draft.loading && !draft.data) return <LoadingState />;
  if (draft.error && !draft.data) return <ErrorState error={draft.error} onRetry={draft.reload} />;
  const d = draft.data;
  if (!d) return null;
  const canFill = Boolean(d.canFill) && d.status !== 'superseded';
  const section = d.sections[Math.min(step, d.sections.length - 1)]!;
  const issuesIn = (key: string) => d.issues.filter((i) => i.blocking && i.fieldKey && d.sections.find((s) => s.key === key)!.fields.some((f) => f.key === i.fieldKey)).length;
  const reload = (): void => {
    draft.reload();
    onChanged();
  };
  const openField = (fieldKey: string | null): void => {
    if (!fieldKey) return;
    const at = d.sections.findIndex((s) => s.fields.some((f) => f.key === fieldKey));
    if (at >= 0) setStep(at);
    window.setTimeout(() => document.getElementById(`field-${fieldKey}`)?.scrollIntoView({ block: 'start' }), 50);
  };
  const act = (fn: () => Promise<unknown>, done: string): void => {
    setBusy(true);
    fn().then(
      () => {
        setBusy(false);
        toast.push({ kind: 'success', text: done });
        reload();
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
        reload();
      },
    );
  };
  const lastRun = runs.data?.items[0] ?? null;
  const report = d.migrationReport;

  return (
    <div className={form.stack}>
      <section className={form.section} aria-labelledby="draft-title">
        <div className={form.sectionHead}>
          <h3 id="draft-title" className={form.sectionTitle}>
            {d.title}
          </h3>
          <div className={styles.badges}>
            <Badge label={DRAFT_STATUS[d.status]!.label} icon={d.status === 'complete' ? 'check' : 'circle-dot'} tone={DRAFT_STATUS[d.status]!.tone} />
            <Badge label={`Ревизия шаблона № ${d.template.revisionSeq}`} icon="file-signature" tone="neutral" />
          </div>
        </div>
        {d.template.isDemo ? <Notice tone="warning">Демонстрационная форма с вымышленным текстом — не для выпуска. Генерация production-приложений заблокирована до проверки реальных форм.</Notice> : null}
        {d.supersededByDraftId ? (
          <Notice tone="info" action={<Button onClick={() => onOpenDraft(d.supersededByDraftId!)}>Открыть новое</Button>}>
            Приложение перенесено на новую ревизию шаблона и больше не меняется.
          </Notice>
        ) : null}
        {d.template.newerRevisionAvailable && d.status !== 'superseded' ? (
          <Notice
            tone="info"
            action={
              canFill ? (
                <Button icon="repeat" loading={busy} onClick={() => act(() => migrateDraft(d).then((r) => onOpenDraft(r.id)), 'Перенесено: подтвердите перенесённые значения')}>
                  Перенести
                </Button>
              ) : undefined
            }
          >
            Утверждена новая ревизия шаблона. Перенос — новый черновик: значения переносятся с пометкой «перенесено — подтвердите».
          </Notice>
        ) : null}
        {report ? (
          <details className={form.details}>
            <summary>Отчёт переноса с прежней ревизии</summary>
            <ul className={styles.list}>
              {report.carried
                .filter((c) => c.changes.length > 0)
                .map((c) => (
                  <li key={c.key} className={styles.muted}>{`${c.label}: изменено — ${c.changes.map((x) => CHANGE_LABEL[x.kind] ?? x.kind).join(', ')}`}</li>
                ))}
              {report.dropped.map((x) => (
                <li key={x.key} className={styles.muted}>{`${x.label}: не перенесено — ${x.detail}`}</li>
              ))}
              {report.added.map((x) => (
                <li key={x.key} className={styles.muted}>{`${x.label}: новое поле${x.required ? ', обязательное' : ''}`}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className={styles.row}>
          {canFill ? (
            <Button
              variant="primary"
              icon="check"
              disabled={d.blocking > 0 || d.status !== 'in_progress'}
              loading={busy}
              onClick={() => act(() => completeDraft(d), 'Приложение отмечено «заполнено»')}
            >
              Отметить «заполнено»
            </Button>
          ) : null}
          {canFill ? (
            <Button
              icon="scan-search"
              loading={active}
              onClick={() =>
                act(
                  () => startSuggestionRun(d.id, idem.keyFor({ draftId: d.id, n: runs.data?.items.length ?? 0 })).then(() => runs.reload()),
                  'Модель ищет значения в источниках этапа: результат — предложения для принятия',
                )
              }
            >
              Предложить значения
            </Button>
          ) : null}
          <span className={styles.muted}>{d.blocking > 0 ? `Незавершённых пунктов: ${d.blocking}` : 'Блокирующих пунктов нет'}</span>
          {lastRun ? <span className={styles.muted}>{`Предложения модели: ${String(lastRun.coverage.suggestions ?? 0)}${lastRun.coverage.falseQuotes ? `, отброшено с ложной цитатой — ${String(lastRun.coverage.falseQuotes)}` : ''}${lastRun.coverage.gap ? ` · ${String(lastRun.coverage.gap)}` : ''}`}</span> : null}
        </div>
      </section>
      <div className={styles.layout}>
        <section className={form.section} aria-label="Разделы приложения">
          <nav className={styles.steps} aria-label="Шаги">
            {d.sections.map((s, i) => (
              <button key={s.key} type="button" className={styles.step} aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>
                {`${i + 1}. ${s.title}`}
                {issuesIn(s.key) > 0 ? <span className={styles.stepCount}>{issuesIn(s.key)}</span> : null}
              </button>
            ))}
          </nav>
          {section.help ? <p className={styles.muted}>{section.help}</p> : null}
          <div className={styles.fields}>
            {section.fields.map((f) => (
              <FieldCard key={`${f.fieldId}:${f.version}`} draftId={d.id} tenderId={d.tenderId} field={f} canFill={canFill} canAskCustomer={canAskCustomer} onChanged={reload} />
            ))}
          </div>
          <div className={styles.actions}>
            <Button icon="arrow-left" disabled={step === 0} onClick={() => setStep(step - 1)}>
              Назад
            </Button>
            <Button icon="chevron-right" disabled={step >= d.sections.length - 1} onClick={() => setStep(step + 1)}>
              Далее
            </Button>
          </div>
        </section>
        <section className={form.section} aria-labelledby="draft-issues">
          <h3 id="draft-issues" className={form.sectionTitle}>
            Незавершённые пункты
          </h3>
          <IssuesList issues={d.issues} onOpen={openField} />
        </section>
      </div>
    </div>
  );
};
