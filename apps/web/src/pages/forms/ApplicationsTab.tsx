import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { createDraft, listDrafts, listTemplates } from '../../api/formsEndpoints';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import form from '../../styles/form.module.css';
import { DraftWizard } from './DraftWizard';
import styles from './Forms.module.css';

interface IApplicationsTabProps {
  stageId: string;
  tenderId: string;
  caps: string[];
}

/**
 * Приложения этапа (этап 11, D-031): список приложений с прогрессом и незавершёнными пунктами, создание по
 * утверждённой ревизии шаблона компании или заказчика, мастер заполнения. Файлы приложений — этап 12.
 */
export const ApplicationsTab: FC<IApplicationsTabProps> = ({ stageId, tenderId, caps }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const drafts = useApiResource((signal) => listDrafts(stageId, signal), stageId);
  const templates = useApiResource((signal) => listTemplates(tenderId, signal), tenderId);
  const [template, setTemplate] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (drafts.loading && !drafts.data) return <LoadingState />;
  if (drafts.error && !drafts.data) return <ErrorState error={drafts.error} onRetry={drafts.reload} />;
  const items = drafts.data?.items ?? [];
  const usable = (templates.data?.items ?? []).filter((t) => t.currentRevisionId);
  const canFill = Boolean(drafts.data?.canFill);
  const create = (): void => {
    const t = usable.find((x) => x.id === template);
    if (!t?.currentRevisionId) return;
    setBusy(true);
    createDraft(stageId, t.currentRevisionId, idem.keyFor({ stageId, revision: t.currentRevisionId })).then(
      (d) => {
        idem.reset();
        setBusy(false);
        setSelected(d.id);
        drafts.reload();
        toast.push({ kind: 'success', text: 'Приложение создано' });
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
      },
    );
  };

  return (
    <div className={form.stack}>
      <section className={form.section} aria-labelledby="apps-title">
        <div className={form.sectionHead}>
          <h3 id="apps-title" className={form.sectionTitle}>
            Приложения этапа
          </h3>
        </div>
        {canFill ? (
          <div className={styles.row}>
            <SelectField
              label="Шаблон"
              value={template}
              placeholder={usable.length ? 'Выберите шаблон' : 'Нет утверждённых шаблонов'}
              options={usable.map((t) => ({ value: t.id, label: `${t.name}${t.isDemo ? ' (демо)' : ''} · ревизия ${t.currentSeq ?? '—'}` }))}
              onValueChange={setTemplate}
            />
            <Button variant="primary" icon="plus" loading={busy} disabled={!template} onClick={create}>
              Создать приложение
            </Button>
          </div>
        ) : null}
        {items.length === 0 ? (
          <EmptyState icon="file-signature" title="Приложений пока нет" text="Приложение создаётся по утверждённой ревизии шаблона компании или заказчика." />
        ) : (
          <ul className={styles.list}>
            {items.map((d) => (
              <li key={d.id}>
                <button type="button" className={styles.draftItem} aria-current={selected === d.id ? 'true' : undefined} onClick={() => setSelected(d.id)}>
                  <span className={styles.label}>{d.title}</span>
                  <span className={styles.badges}>
                    {d.isDemo ? <Badge label="Демо — не для выпуска" icon="info" tone="warning" dashed /> : null}
                    <Badge label={d.status === 'complete' ? 'Заполнено' : d.status === 'superseded' ? 'Заменено' : 'В работе'} icon={d.status === 'complete' ? 'check' : 'circle-dot'} tone={d.status === 'complete' ? 'success' : d.status === 'superseded' ? 'muted' : 'info'} />
                    {d.template.newerRevisionAvailable && d.status !== 'superseded' ? <Badge label="Есть новая ревизия шаблона" icon="repeat" tone="info" /> : null}
                  </span>
                  <span className={styles.muted}>{`${d.template.name} · заполнено полей ${d.filled} из ${d.fields}${d.status !== 'superseded' ? ` · незавершённых пунктов ${d.blocking}` : ''}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {selected ? <DraftWizard key={selected} draftId={selected} canAskCustomer={caps.includes('requirement.create')} onOpenDraft={setSelected} onChanged={drafts.reload} /> : null}
    </div>
  );
};
