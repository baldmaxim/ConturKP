import { useState, type FC } from 'react';
import { useParams } from 'react-router-dom';
import { getMailMessage, getMailRevision } from '../../api/mailEndpoints';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { PageHeader } from '../../components/PageHeader';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import { DIRECTION_LABELS } from '../../utils/mailLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import { MailLinksPanel } from './MailLinksPanel';
import { MailRevisionView } from './MailRevisionView';
import styles from './Mail.module.css';

const HistoricRevision: FC<{ revisionId: string }> = ({ revisionId }) => {
  const res = useApiResource((signal) => getMailRevision(revisionId, signal), revisionId);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  return <MailRevisionView revision={res.data} canRecognize={false} onChanged={res.reload} />;
};

/**
 * Карточка письма (этап 07): копия в одном ящике, неизменяемые ревизии, вложения-документы, копии той же
 * коммуникации в читаемых ящиках и связи с тендерами. Это не почтовый клиент: ни ответа, ни отправки,
 * ни пометок прочтения — только чтение, импорт и доказательства.
 */
export const MailMessagePage: FC = () => {
  const { messageId = '' } = useParams();
  const res = useApiResource((signal) => getMailMessage(messageId, signal), messageId);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const m = res.data;

  if (res.loading && !m) return <LoadingState />;
  if (res.error || !m) return <ErrorState error={res.error} onRetry={res.reload} notFoundTitle="Письмо не найдено или нет доступа" />;

  const shown = revisionId && revisionId !== m.current.id ? revisionId : null;

  return (
    <>
      <PageHeader
        back={{ to: `/mailboxes/${m.mailboxId}`, label: m.mailboxName }}
        title={m.subject ?? 'Без темы'}
        subtitle={
          <span className={styles.headLine}>
            <span>{m.from ?? 'отправитель не указан'}</span>
            <span className={list.num}>{m.sentAt ? `${formatDateTime(m.sentAt)} МСК` : ''}</span>
            <Badge tone={m.direction === 'outbound' ? 'info' : 'neutral'} icon={m.direction === 'outbound' ? 'upload' : 'inbox'} label={DIRECTION_LABELS[m.direction]} />
          </span>
        }
      />
      <div className={form.stack}>
        {m.revisionList.length > 1 ? (
          <section className={form.section} aria-label="Ревизии письма">
            <SelectField
              label="Ревизия"
              value={shown ?? m.current.id}
              options={m.revisionList.map((r) => ({ value: r.id, label: `${r.seq}${r.id === m.current.id ? ' — текущая' : ''} · импорт ${formatDateTime(r.createdAt)} МСК` }))}
              onValueChange={setRevisionId}
              hint="Изменённая копия с тем же идентификатором — новая ревизия; прежняя остаётся и фиксируется снимками."
            />
            {shown ? <Notice tone="warning">Показана прежняя ревизия письма.</Notice> : null}
          </section>
        ) : null}
        {shown ? <HistoricRevision revisionId={shown} /> : <MailRevisionView revision={m.current} canRecognize={m.capabilities.includes('mail.import')} onChanged={res.reload} />}
        <MailLinksPanel message={m} onChanged={res.reload} />
        {m.siblings.length > 0 ? (
          <section className={form.section} aria-labelledby="mail-siblings">
            <h2 id="mail-siblings" className={form.sectionTitle}>
              Копии в других ящиках
            </h2>
            <ul className={styles.cards}>
              {m.siblings.map((sib) => (
                <li key={sib.messageId} className={list.card}>
                  <AppLink className={list.rowLink} to={`/mail-messages/${sib.messageId}`}>
                    {sib.mailboxName}
                  </AppLink>
                  <p className={list.muted}>{[DIRECTION_LABELS[sib.direction], sib.folder].filter(Boolean).join(' · ')}</p>
                </li>
              ))}
            </ul>
            <p className={list.muted}>Показаны только копии в ящиках, которые вы читаете.</p>
          </section>
        ) : null}
      </div>
    </>
  );
};
