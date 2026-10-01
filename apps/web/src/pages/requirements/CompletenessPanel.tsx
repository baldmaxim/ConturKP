import { useState, type FC } from 'react';
import { newUuid } from '../../api/client';
import { describeError } from '../../api/errors';
import { completeReview, getCompleteness, listFragmentStates, markFragments } from '../../api/requirementEndpoints';
import type { IUnitCompleteness } from '../../api/requirementTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { fragmentStateBadge, SOURCE_KIND_LABELS } from '../../utils/requirementLabels';
import styles from './Requirements.module.css';

const unitTitle = (u: IUnitCompleteness): string => {
  if (!u.unit) return 'Единица снимка';
  if (u.unit.restricted) return 'Закрытый источник';
  return u.unit.documentTitle ?? u.unit.mailSubject ?? u.unit.sessionTitle ?? (u.unit.qaItemNo ? `Вопрос ${u.unit.qaItemNo}${u.unit.qaThreadTitle ? ` · ${u.unit.qaThreadTitle}` : ''}` : 'Единица снимка');
};

const selectorOf = (u: IUnitCompleteness): Record<string, unknown> | null =>
  u.unit?.documentRevisionId
    ? { kind: 'document_revision', documentRevisionId: u.unit.documentRevisionId }
    : u.unit?.mailMessageRevisionId
      ? { kind: 'mail_message_revision', mailMessageRevisionId: u.unit.mailMessageRevisionId }
      : u.unit?.qaItemRevisionId
        ? { kind: 'qa_item_revision', qaItemRevisionId: u.unit.qaItemRevisionId }
        : u.unit?.transcriptRevisionId
          ? { kind: 'transcript_revision', transcriptRevisionId: u.unit.transcriptRevisionId }
          : null;

const UnitFragments: FC<{ registryId: string; unit: IUnitCompleteness; canMark: boolean; reason: string; onMarked: () => void }> = ({ registryId, unit, canMark, reason, onMarked }) => {
  const [version, setVersion] = useState(0);
  const res = useApiResource((signal) => listFragmentStates(registryId, { scopeItemId: unit.scopeItemId }, signal), `fs:${unit.scopeItemId}:${version}`);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const mark = async (selector: Record<string, unknown>, m: 'not_requirement' | 'cleared'): Promise<void> => {
    setError(null);
    try {
      const r = await markFragments(registryId, { mark: m, reason: m === 'not_requirement' ? reason.trim() || null : null, selector }, newUuid());
      toast.push({ kind: 'success', text: `Отмечено фрагментов: ${r.fragmentIds.length}` });
      setVersion((v) => v + 1);
      onMarked();
    } catch (e) {
      setError(describeError(e));
    }
  };
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  return (
    <div className={styles.stack}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <ul className={styles.evidence}>
        {res.data.items.map((f) => (
          <li key={f.fragmentId} className={styles.evidenceItem}>
            <div className={styles.headLine}>
              {fragmentStateBadge(f.state)}
              {f.pageIndex !== null ? <span className={styles.muted}>{`стр. ${f.pageIndex + 1}`}</span> : null}
            </div>
            {f.restricted ? <p className={styles.restricted}>Нет права на источник — текст не показывается.</p> : <p className={styles.quote}>{f.text}</p>}
            {canMark && !f.restricted && f.state === 'unreviewed' ? (
              <Button variant="ghost" icon="x" disabled={!reason.trim()} onClick={() => void mark({ kind: 'fragments', fragmentIds: [f.fragmentId] }, 'not_requirement')}>
                Не требование
              </Button>
            ) : null}
            {canMark && f.state === 'explicitly_not_requirement' ? (
              <Button variant="ghost" icon="repeat" onClick={() => void mark({ kind: 'fragments', fragmentIds: [f.fragmentId] }, 'cleared')}>
                Снять отметку
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * Полнота реестра (OD-08-7, Р-08-7): по фрагментам снимка — связан с требованием или фактом, помечен «не
 * требование» или не просмотрен. Пакетная отметка разворачивается в конкретные фрагменты. Реестр полон только
 * при нуле непросмотренных; единица без фрагментов показана отдельно и не исчезает.
 */
export const CompletenessPanel: FC<{ registryId: string; caps: string[]; onChanged: () => void }> = ({ registryId, caps, onChanged }) => {
  const [version, setVersion] = useState(0);
  const res = useApiResource((signal) => getCompleteness(registryId, signal), `completeness:${registryId}:${version}`);
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const canMark = caps.includes('requirement.create');
  const reload = (): void => {
    setVersion((v) => v + 1);
    onChanged();
  };
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const { counts, units, reviews } = res.data;
  const markUnit = async (u: IUnitCompleteness): Promise<void> => {
    const selector = selectorOf(u);
    if (!selector) return;
    setError(null);
    try {
      const r = await markFragments(registryId, { mark: 'not_requirement', reason: reason.trim(), selector }, newUuid());
      toast.push({ kind: 'success', text: `Отмечено фрагментов: ${r.fragmentIds.length}` });
      reload();
    } catch (e) {
      setError(describeError(e));
    }
  };
  const complete = async (): Promise<void> => {
    setError(null);
    try {
      await completeReview(registryId, newUuid());
      toast.push({ kind: 'success', text: 'Проход полноты завершён' });
      reload();
    } catch (e) {
      setError(describeError(e));
    }
  };
  return (
    <div className={styles.stack}>
      <dl className={styles.meter}>
        <div>
          <dt>Фрагментов</dt>
          <dd>{counts.total_units}</dd>
        </div>
        <div>
          <dt>Связаны с требованиями</dt>
          <dd>{counts.covered_units}</dd>
        </div>
        <div>
          <dt>Только с фактами</dt>
          <dd>{counts.reviewed_units - counts.covered_units}</dd>
        </div>
        <div>
          <dt>Не требование</dt>
          <dd>{counts.explicit_not_requirement_units}</dd>
        </div>
        <div>
          <dt>Не просмотрено</dt>
          <dd>{counts.unreviewed_units}</dd>
        </div>
      </dl>
      {counts.empty_units > 0 ? <Notice tone="warning">{`Единиц без допустимых фрагментов: ${counts.empty_units} — проверьте распознавание.`}</Notice> : null}
      {reviews[0] ? <p className={styles.muted}>{`Последнее завершение прохода: ${formatDateTime(reviews[0].completed_at)} МСК`}</p> : null}
      {canMark ? <TextField label="Причина отметки «не требование»" value={reason} onValueChange={setReason} hint="Обязательна для отметки" /> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {caps.includes('requirement.manage') ? (
        <div className={styles.actions}>
          <Button variant="primary" icon="list-checks" disabled={counts.unreviewed_units > 0} onClick={() => void complete()}>
            Завершить проход полноты
          </Button>
        </div>
      ) : null}
      <ul className={styles.cards}>
        {units.map((u) => (
          <li key={u.scopeItemId} className={styles.card}>
            <div className={styles.headLine}>
              <strong>{unitTitle(u)}</strong>
              <span className={styles.muted}>{SOURCE_KIND_LABELS[u.unitType === 'document_recognition' ? 'recognition_run' : u.unitType] ?? u.unitType}</span>
              {u.technicalStatus !== 'ok' ? (
                <Badge tone="warning" icon="file-question-mark" dashed label={u.technicalStatus === 'not_recognized' ? 'Не распознано' : 'Нет текстовых фрагментов'} />
              ) : u.unreviewed === 0 ? (
                <Badge tone="success" icon="check" label="Просмотрено" />
              ) : (
                <Badge tone="warning" icon="hourglass" dashed label={`Не просмотрено: ${u.unreviewed} из ${u.total}`} />
              )}
            </div>
            <div className={styles.actions}>
              {u.total > 0 ? (
                <Button variant="ghost" icon={open === u.scopeItemId ? 'chevron-down' : 'chevron-right'} aria-expanded={open === u.scopeItemId} onClick={() => setOpen(open === u.scopeItemId ? null : u.scopeItemId)}>
                  Фрагменты
                </Button>
              ) : null}
              {canMark && u.unreviewed > 0 && !u.unit?.restricted && selectorOf(u) ? (
                <Button variant="secondary" icon="x" disabled={!reason.trim()} onClick={() => void markUnit(u)}>
                  Всё остальное — не требование
                </Button>
              ) : null}
            </div>
            {open === u.scopeItemId ? <UnitFragments registryId={registryId} unit={u} canMark={canMark} reason={reason} onMarked={reload} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
};
