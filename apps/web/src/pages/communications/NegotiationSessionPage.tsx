import type { FC } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getNegotiationSession } from '../../api/mailEndpoints';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { PageHeader } from '../../components/PageHeader';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { cx } from '../../utils/cx';
import { formatDateTime } from '../../utils/datetime';
import { formatTimecode, SIDE_LABELS } from '../../utils/mailLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from '../mail/Mail.module.css';

/**
 * Сессия переговоров: участники, редакции транскрипции и сегменты выбранной редакции. Подсказка сервиса
 * участнику — отдельный вид сегмента с пунктирной рамкой: это не слова стороны переговоров (I06, A03).
 */
export const NegotiationSessionPage: FC = () => {
  const { sessionId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const revisionId = params.get('revision');
  const res = useApiResource((signal) => getNegotiationSession(sessionId, revisionId, signal), `${sessionId}:${revisionId ?? ''}`);
  const s = res.data;
  if (res.loading && !s) return <LoadingState />;
  if (res.error || !s) return <ErrorState error={res.error} onRetry={res.reload} notFoundTitle="Сессия не найдена или нет доступа" />;
  const speaker = new Map(s.participants.map((p) => [p.speakerLabel, p]));
  const latest = s.revision?.id === s.latestRevisionId;

  return (
    <>
      <PageHeader back={{ to: `/tenders/${s.tenderId}?tab=negotiations`, label: 'Переговоры тендера' }} title={s.title ?? s.externalSessionId} subtitle={`${formatDateTime(s.startedAt)} МСК`} />
      <div className={form.stack}>
        <section className={form.section} aria-label="Участники">
          <dl className={form.details}>
            {s.participants.map((p) => (
              <div key={p.speakerLabel}>
                <dt>{p.speakerLabel}</dt>
                <dd>{`${p.name ?? 'имя не указано'} · ${SIDE_LABELS[p.side]}`}</dd>
              </div>
            ))}
            <div>
              <dt>Аудио</dt>
              <dd className={styles.address}>{s.audioRef ?? 'не указано'}</dd>
            </div>
          </dl>
        </section>
        {s.revisionList.length > 1 ? (
          <section className={form.section} aria-label="Редакции транскрипции">
            <SelectField
              label="Редакция транскрипции"
              value={s.revision?.id ?? ''}
              options={s.revisionList.map((r) => ({ value: r.id, label: `${r.seq}${r.id === s.latestRevisionId ? ' — текущая' : ''} · ${r.sourceRevision} · ${formatDateTime(r.createdAt)} МСК` }))}
              onValueChange={(v) => setParams({ revision: v }, { replace: true })}
            />
            {!latest ? <Notice tone="warning">Показана прежняя редакция транскрипции.</Notice> : null}
          </section>
        ) : null}
        <ol className={styles.body} aria-label="Сегменты">
          {s.segments.map((seg) => (
            <li key={seg.id} className={cx(styles.segment, seg.kind === 'hint' && styles.hint)}>
              <div className={styles.segmentHead}>
                <span className={list.num}>{`${formatTimecode(seg.startMs)}–${formatTimecode(seg.endMs)}`}</span>
                <span>{speaker.get(seg.speakerLabel)?.name ?? seg.speakerLabel}</span>
                {seg.kind === 'hint' ? <Badge tone="muted" icon="info" dashed label="Подсказка участнику" /> : null}
              </div>
              <div>
                <p className={styles.block}>{seg.text}</p>
                <AppLink className={list.rowLink} to={`/evidence/${seg.fragmentId}`}>
                  Доказательство
                </AppLink>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
};
