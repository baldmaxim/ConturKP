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
import { mailReadingSections } from '../../utils/mailBodyPresentation';
import { DIRECTION_LABELS, REJECT_REASON_LABELS } from '../../utils/mailLabels';
import { formatBytes, RECOGNITION_STATUS } from '../../utils/sourceLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './Mail.module.css';

const ROLE_LABELS: Record<string, string> = { from: 'От', sender: 'Отправитель', to: 'Кому', cc: 'Копия', bcc: 'Скрытая копия', reply_to: 'Ответить' };
const SENDER_ROLES = new Set(['from', 'sender']);

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
    <section className={styles.envelope} aria-label="Шапка письма">
      <div className={styles.subject}>
        <h2>{revision.subject ?? 'Без темы'}</h2>
      </div>
      <dl className={styles.envelopeMeta}>
        {revision.participants.filter((p) => SENDER_ROLES.has(p.role)).map((p, i) => (
          <div key={`${p.role}:${p.address}:${i}`}>
            <dt>{ROLE_LABELS[p.role] ?? p.role}</dt>
            <dd className={styles.address}>{p.name ? `${p.name} <${p.address}>` : p.address}</dd>
          </div>
        ))}
        <div>
          <dt>Отправлено</dt>
          <dd className={form.num}>{revision.sentAt ? `${formatDateTime(revision.sentAt)} МСК` : 'дата не указана'}</dd>
        </div>
      </dl>
      {revision.participants.some((p) => !SENDER_ROLES.has(p.role)) ? (
        <details key={`${revision.id}:recipients`} className={styles.recipientDetails}>
          <summary>Получатели и копии</summary>
          <dl className={form.details}>
            {revision.participants.filter((p) => !SENDER_ROLES.has(p.role)).map((p, i) => (
              <div key={`${p.role}:${p.address}:${i}`}>
                <dt>{ROLE_LABELS[p.role] ?? p.role}</dt>
                <dd className={styles.address}>{p.name ? `${p.name} <${p.address}>` : p.address}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </section>
    <section className={styles.readingPane} aria-label="Текст письма">
      <h2 className={form.sectionTitle}>Текст письма</h2>
      {revision.body.length === 0 ? <p className={list.muted}>Текста у письма нет.</p> : null}
      {mailReadingSections(revision.body).map((section, index) => section.kind === 'message' ? (
        <div key={index} className={styles.messageText}>{section.text}</div>
      ) : section.kind === 'signature' ? (
        <details key={`${revision.id}:signature:${index}`} className={styles.signature}>
          <summary>Подпись и служебная информация</summary>
          <aside aria-label="Подпись отправителя">{section.text}</aside>
        </details>
      ) : (
        <details key={index} className={styles.previousMessages}>
          <summary>Предыдущая переписка</summary>
          <blockquote>{section.text}</blockquote>
        </details>
      ))}
    </section>
    <details className={styles.sourceDetails}>
      <summary>Сведения об источнике</summary>
      <p>{`${DIRECTION_LABELS[revision.direction]} · Ревизия ${revision.seq} · импорт ${formatDateTime(revision.createdAt)} МСК`}</p>
    </details>
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
