import { useState, type FC } from 'react';
import { newUuid } from '../../api/client';
import { describeError } from '../../api/errors';
import type { IMailAttachment, IMailRevisionDetail } from '../../api/mailTypes';
import { requestLocalRecognition } from '../../api/recognitionEndpoints';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { DIRECTION_LABELS, REJECT_REASON_LABELS } from '../../utils/mailLabels';
import { formatBytes, RECOGNITION_STATUS } from '../../utils/sourceLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './Mail.module.css';

const ROLE_LABELS: Record<string, string> = { from: 'От', sender: 'Отправитель', to: 'Кому', cc: 'Копия', bcc: 'Скрытая копия', reply_to: 'Ответить' };

const attachmentBadge = (a: IMailAttachment) => {
  if (a.status === 'rejected') return <Badge tone="warning" icon="file-exclamation-point" dashed label={`Не принято: ${REJECT_REASON_LABELS[a.rejectReason ?? ''] ?? a.rejectReason}`} />;
  const status = a.runStatus as keyof typeof RECOGNITION_STATUS | null;
  if (!status) return <Badge tone="neutral" icon="file-question-mark" dashed label="Не распознано" />;
  const meta = RECOGNITION_STATUS[status];
  return <Badge tone={meta.tone} icon={meta.icon} dashed={meta.dashed} label={meta.label} />;
};

// Распознавание вложения — общий путь 05a: DOCX, XLSX и CSV — автопроходом, PDF — этой командой
// (политика auto, OD-1). Команда требует права импорта в ящик письма.
const RecognizeButton: FC<{ attachment: IMailAttachment; onDone: () => void }> = ({ attachment, onDone }) => {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      await requestLocalRecognition(attachment.documentRevisionId!, newUuid());
      toast.push({ kind: 'success', text: `Распознавание «${attachment.filename}» поставлено в очередь.` });
      onDone();
    } catch (e) {
      toast.push({ kind: 'error', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button icon="scan-search" loading={busy} onClick={() => void run()}>
      Распознать
    </Button>
  );
};

/**
 * Ревизия письма — неизменяемый снимок источника: шапка, тело по блокам и вложения. Цитата прежней
 * переписки выделена и подписана: старый ответ из цитаты не читается как новое утверждение.
 */
export const MailRevisionView: FC<{ revision: IMailRevisionDetail; canRecognize: boolean; onChanged: () => void }> = ({ revision, canRecognize, onChanged }) => (
  <>
    {revision.warnings.includes('identity_content_changed') ? (
      <Notice tone="warning">Копия с тем же идентификатором отличается от прежней: это новая ревизия письма, прежняя сохранена.</Notice>
    ) : null}
    <section className={form.section} aria-label="Шапка письма">
      <dl className={form.details}>
        {revision.participants.map((p, i) => (
          <div key={`${p.role}:${p.address}:${i}`}>
            <dt>{ROLE_LABELS[p.role] ?? p.role}</dt>
            <dd className={styles.address}>{p.name ? `${p.name} <${p.address}>` : p.address}</dd>
          </div>
        ))}
        <div>
          <dt>Отправлено</dt>
          <dd className={form.num}>{revision.sentAt ? `${formatDateTime(revision.sentAt)} МСК` : 'дата не указана'}</dd>
        </div>
        <div>
          <dt>Направление</dt>
          <dd>{DIRECTION_LABELS[revision.direction]}</dd>
        </div>
        <div>
          <dt>Ревизия</dt>
          <dd className={form.num}>{`${revision.seq} · импорт ${formatDateTime(revision.createdAt)} МСК`}</dd>
        </div>
      </dl>
    </section>
    <section className={form.section} aria-label="Текст письма">
      {revision.body.length === 0 ? <p className={list.muted}>Текста у письма нет.</p> : null}
      <ol className={styles.body}>
        {revision.body.map((b) => (
          <li key={b.fragmentId}>
            {b.quoted ? (
              <blockquote className={styles.quoted}>
                <span className={styles.quoteLabel}>Цитата прежней переписки</span>
                {b.text}
              </blockquote>
            ) : (
              <p className={styles.block}>{b.text}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
    {revision.attachments.length > 0 ? (
      <section className={form.section} aria-labelledby="mail-attachments">
        <h2 id="mail-attachments" className={form.sectionTitle}>
          Вложения
        </h2>
        <ul className={styles.cards}>
          {revision.attachments.map((a) => (
            <li key={a.id} className={list.card}>
              <div className={list.cardHead}>
                <span className={list.cardTitle}>{a.filename}</span>
                {attachmentBadge(a)}
              </div>
              <dl className={list.meta}>
                <dt>Размер</dt>
                <dd className={list.num}>{formatBytes(a.sizeBytes)}</dd>
                <dt>Вид</dt>
                <dd>{a.disposition === 'inline' ? 'В тексте письма' : 'Вложение'}</dd>
              </dl>
              <div className={styles.actions}>
                {a.contentUrl ? (
                  <a className={list.rowLink} href={a.contentUrl} target="_blank" rel="noopener">
                    Скачать
                  </a>
                ) : null}
                {canRecognize && a.documentRevisionId && a.runStatus !== 'complete' && a.runStatus !== 'queued' && a.runStatus !== 'running' ? (
                  <RecognizeButton attachment={a} onDone={onChanged} />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
    ) : null}
  </>
);
