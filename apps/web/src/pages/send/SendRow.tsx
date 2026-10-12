import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { acceptSendExtras, sendEvidenceUrl } from '../../api/sendEndpoints';
import type { ISendView } from '../../api/sendTypes';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { formatBytes } from '../../utils/releaseLabels';
import { FILE_CLASS, SEND_CHANNEL, SEND_STATUS } from '../../utils/sendLabels';
import { ReasonDialog } from '../release/ReasonDialog';
import styles from '../release/Release.module.css';
import own from './Send.module.css';

const fileLine = (f: ISendView['files'][number]): string => {
  const what = f.class === 'kit' ? `${FILE_CLASS.kit}: ${f.kitPath}` : f.class === 'other_release' ? `${FILE_CLASS.other_release} № ${f.otherReleaseSeq ?? '—'}` : FILE_CLASS[f.class];
  return `${f.fileName ?? 'имя закрыто'}${f.inline ? ' (встроено в письмо)' : ''} — ${what}`;
};

/**
 * Запись отправки: канал, время, основание и результат сверки вложений с комплектом. Тема, адреса и имена вложений
 * письма видны только тому, кто читает его ящик; остальным — «письмо закрыто». «Состав не совпал» отправкой
 * утверждённого комплекта не считается (A32); лишние вложения принимает руководитель с причиной (D-035).
 */
export const SendRow: FC<{ s: ISendView; onChanged: () => void }> = ({ s, onChanged }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = SEND_STATUS[s.status]!;
  const mail = s.evidence.mail;
  const missing = s.check.missing ?? [];
  const accept = (reason: string): void => {
    setBusy(true);
    acceptSendExtras(s, reason, idem.keyFor({ id: s.id, reason })).then(
      () => {
        idem.reset();
        setBusy(false);
        setDialog(false);
        toast.push({ kind: 'success', text: 'Лишние вложения приняты: отправка подтверждена.' });
        onChanged();
      },
      (e: unknown) => {
        setBusy(false);
        toast.push({ kind: 'error', text: describeError(e) });
        onChanged();
      },
    );
  };
  return (
    <li className={own.send} data-status={s.status}>
      <div className={styles.head}>
        <span className={styles.label}>{`Отправка № ${s.seq} · ${SEND_CHANNEL[s.channel] ?? s.channel} · ${formatDateTime(s.sentAt)}`}</span>
        <span className={own.badges}>
          <Badge label={status.label} icon={status.icon} tone={status.tone} dashed={status.dashed} />
          {s.extrasAccepted ? <Badge label="Лишние вложения приняты" icon="user-check" tone="info" /> : null}
          {s.repeat ? <Badge label="Повторная" icon="repeat" tone="muted" /> : null}
        </span>
      </div>
      {mail ? (
        mail.restricted ? (
          <span className={styles.muted}>Основание — письмо из почты портала; оно закрыто для вас: тема, адресаты и имена вложений не показаны.</span>
        ) : (
          <span className={styles.muted}>
            {`Письмо «${mail.subject ?? '(без темы)'}» · кому: ${mail.recipients.join(', ') || '—'}${mail.copies.length > 1 ? ` · копии письма: ${mail.copies.map((c) => `${c.mailboxName}${c.folder ? ` / ${c.folder}` : ''}`).join('; ')}` : ''}`}
          </span>
        )
      ) : null}
      {s.evidence.file ? (
        <span className={styles.actions}>
          <a className={styles.download} href={sendEvidenceUrl(s.id)} download>
            {`Основание: ${s.evidence.file.fileName}`}
          </a>
        </span>
      ) : null}
      {s.status === 'registered' ? <span className={styles.muted}>Состав отправки не сверялся: машинного основания нет.</span> : null}
      {s.evidence.kind === 'manual_note' ? <span className={styles.muted}>Основание — только пояснение, файла нет.</span> : null}
      {s.recipients.length > 0 ? <span className={styles.muted}>{`Адресаты: ${s.recipients.join(', ')}`}</span> : null}
      {s.note ? <span className={styles.muted}>{s.note}</span> : null}
      {s.status === 'disputed' ? (
        <span className={styles.error}>
          {`Не считается отправкой утверждённого комплекта.${missing.length > 0 ? ` Нет файлов комплекта: ${missing.map((m) => m.path).join(', ')}.` : ''}${s.check.extras && s.check.extras.internal > 0 ? ` Внутренних файлов: ${s.check.extras.internal}.` : ''}${s.check.extras && s.check.extras.otherRelease > 0 ? ` Файлов другого комплекта: ${s.check.extras.otherRelease}.` : ''}${s.check.extras && s.check.extras.unknown > 0 ? ` Лишних вложений: ${s.check.extras.unknown}.` : ''}`}
        </span>
      ) : null}
      <span className={styles.muted}>{`Зарегистрировал ${s.registeredBy.name}, ${formatDateTime(s.registeredAt)}`}</span>
      {s.files.length > 0 || s.decisions.length > 0 ? (
        <details className={styles.details}>
          <summary>{`Вложения письма (${s.files.length}) и решения`}</summary>
          <ul className={styles.checks}>
            {s.files.map((f) => (
              <li key={f.ordinal} className={styles.check}>
                <span>{fileLine(f)}</span>
                <span className={styles.mono}>{`${formatBytes(f.size)} · ${f.sha256.slice(0, 12)}…`}</span>
              </li>
            ))}
            {s.decisions.map((d, n) => (
              <li key={`d${n}`} className={styles.check}>
                <span>{`${formatDateTime(d.createdAt)} · лишние вложения принял ${d.actor.name}`}</span>
                <span className={styles.muted}>{d.restricted ? 'причина закрыта: письмо недоступно вам' : d.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {s.actions.acceptExtras ? (
        <span className={styles.actions}>
          <Button icon="user-check" className={own.wrapButton} onClick={() => setDialog(true)}>
            Принять лишние вложения…
          </Button>
        </span>
      ) : null}
      {dialog ? (
        <ReasonDialog title="Принять лишние вложения" label="Почему они не относятся к комплекту" confirmLabel="Принять" confirmIcon="user-check" minLength={3} busy={busy} onConfirm={accept} onClose={() => setDialog(false)}>
          <p className={styles.muted}>Все файлы комплекта в письме есть. Лишние вложения — например, картинка подписи — после принятия отправка считается подтверждённой. Отменить решение нельзя.</p>
        </ReasonDialog>
      ) : null}
    </li>
  );
};
