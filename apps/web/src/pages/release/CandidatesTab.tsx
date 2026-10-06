import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { listDrafts } from '../../api/formsEndpoints';
import { createCandidate, listAttachments, listCandidates } from '../../api/releaseEndpoints';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { CANDIDATE_STATUS, MODE_LABEL } from '../../utils/releaseLabels';
import form from '../../styles/form.module.css';
import { CandidateDetail } from './CandidateDetail';
import styles from './Release.module.css';

interface ICandidatesTabProps {
  stageId: string;
}

/**
 * Комплект этапа (этап 12; D-032): сборка кандидата из «заполненных» приложений и стандартных вложений, список
 * кандидатов, просмотр выбранного. Собранный комплект — кандидат к согласованию (этап 13), не разрешение на выпуск.
 */
export const CandidatesTab: FC<ICandidatesTabProps> = ({ stageId }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const list = useApiResource((signal) => listCandidates(stageId, signal), stageId);
  const drafts = useApiResource((signal) => listDrafts(stageId, signal), `drafts:${stageId}`);
  const attachments = useApiResource((signal) => listAttachments(signal), 'attachments');
  const [mode, setMode] = useState<'test' | 'production'>('test');
  const [chosen, setChosen] = useState<string[]>([]);
  const [chosenAttachments, setChosenAttachments] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (list.loading && !list.data) return <LoadingState />;
  if (list.error && !list.data) return <ErrorState error={list.error} onRetry={list.reload} />;
  const items = list.data?.items ?? [];
  const complete = (drafts.data?.items ?? []).filter((d) => d.status === 'complete');
  const approved = (attachments.data?.items ?? []).filter((a) => a.status === 'approved');
  const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const submit = (): void => {
    setBusy(true);
    createCandidate(stageId, { mode, draftIds: chosen, attachmentRevisionIds: chosenAttachments }, idem.keyFor({ stageId, mode, chosen, chosenAttachments })).then(
      (c) => {
        idem.reset();
        setBusy(false);
        setSelected(c.id);
        list.reload();
        toast.push({ kind: 'success', text: 'Комплект собирается: файлы, превью и проверки появятся после сборки' });
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
      },
    );
  };
  return (
    <div className={form.stack}>
      {list.data?.canCreate ? (
        <section className={form.section} aria-labelledby="release-new">
          <h3 id="release-new" className={form.sectionTitle}>
            Собрать комплект
          </h3>
          <fieldset className={styles.fieldset}>
            <legend className={styles.label}>Режим</legend>
            {(['test', 'production'] as const).map((m) => (
              <label key={m} className={styles.choice}>
                <input type="radio" name="release-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                <span>{m === 'test' ? 'Тестовый — с отметкой в документах' : 'Боевой — к согласованию (блокеры этапа 13 остаются)'}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className={styles.fieldset}>
            <legend className={styles.label}>Приложения «заполнено»</legend>
            {complete.length === 0 ? <p className={styles.muted}>Нет приложений в статусе «заполнено».</p> : null}
            {complete.map((d) => (
              <label key={d.id} className={styles.choice}>
                <input type="checkbox" checked={chosen.includes(d.id)} onChange={() => setChosen(toggle(chosen, d.id))} />
                <span>{`${d.title} · ${d.template.name}${d.isDemo ? ' (демо)' : ''}`}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className={styles.fieldset}>
            <legend className={styles.label}>Стандартные вложения</legend>
            {approved.length === 0 ? <p className={styles.muted}>Утверждённых вложений нет.</p> : null}
            {approved.map((a) => (
              <label key={a.revisionId} className={styles.choice}>
                <input type="checkbox" checked={chosenAttachments.includes(a.revisionId)} onChange={() => setChosenAttachments(toggle(chosenAttachments, a.revisionId))} />
                <span>{`${a.title} · ${a.fileName} · ревизия № ${a.seq}`}</span>
              </label>
            ))}
          </fieldset>
          {mode === 'production' ? <Notice tone="info">Боевой комплект на демо-форме или предварительном расчёте собирается, но выпустить его нельзя: блокеры снимаются только по правилам этапа 13.</Notice> : null}
          <div className={styles.actions}>
            <Button variant="primary" icon="archive" loading={busy} disabled={chosen.length + chosenAttachments.length === 0} onClick={submit}>
              Собрать комплект
            </Button>
          </div>
        </section>
      ) : null}
      <section className={form.section} aria-labelledby="release-list">
        <h3 id="release-list" className={form.sectionTitle}>
          Комплекты этапа
        </h3>
        {items.length === 0 ? (
          <EmptyState icon="archive" title="Комплектов пока нет" text="Комплект собирается из заполненных приложений по размеченным образцам и стандартных вложений." />
        ) : (
          <ul className={styles.list}>
            {items.map((c) => {
              const s = CANDIDATE_STATUS[c.status]!;
              return (
                <li key={c.id}>
                  <button type="button" className={styles.item} aria-current={selected === c.id ? 'true' : undefined} onClick={() => setSelected(c.id)}>
                    <span className={styles.label}>{`Комплект № ${c.seq} · ${MODE_LABEL[c.mode] ?? c.mode}`}</span>
                    <span className={styles.badges}>
                      <Badge label={s.label} icon={s.icon} tone={s.tone} dashed={s.dashed} />
                      {c.restricted ? <Badge label="Закрыт для вас" icon="lock" tone="muted" /> : null}
                      {!c.current && c.status === 'ready_for_approval' ? <Badge label="Входы изменились" icon="clock-alert" tone="warning" dashed /> : null}
                    </span>
                    <span className={styles.muted}>{`${c.createdBy.name} · ${formatDateTime(c.createdAt)}`}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {selected ? <CandidateDetail key={selected} candidateId={selected} onChanged={list.reload} /> : null}
    </div>
  );
};
