import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { listSendCandidates, registerSend } from '../../api/sendEndpoints';
import type { ISendCandidate, TRegisterSendBody, TSendChannel } from '../../api/sendTypes';
import { uploadSendEvidence } from '../../api/upload';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { SEND_CHANNEL, SEND_WARNING } from '../../utils/sendLabels';
import styles from '../release/Release.module.css';
import own from './Send.module.css';

type TKind = 'mail_message' | 'uploaded_file' | 'manual_note';

const KINDS: { id: TKind; label: string }[] = [
  { id: 'mail_message', label: 'Отправленное письмо из почты портала — вложения сверяются с комплектом' },
  { id: 'uploaded_file', label: 'Файл-основание: накладная, квитанция, снимок экрана' },
  { id: 'manual_note', label: 'Только пояснение, без файла' },
];

const candidateNote = (c: ISendCandidate): string => {
  if (c.registeredSendEventId) return 'уже зарегистрировано как отправка этого выпуска';
  if (c.sentBeforeRelease) return 'отправлено раньше выпуска';
  if (c.check === 'matched') return 'вложения совпадают с комплектом';
  const parts = [
    c.missing > 0 ? `нет файлов комплекта: ${c.missing}` : null,
    c.otherReleaseSeqs.length > 0 ? `вложения комплекта № ${c.otherReleaseSeqs.join(', ')}` : null,
    c.extras.internal > 0 ? `внутренних файлов: ${c.extras.internal}` : null,
    c.extras.unknown > 0 ? `лишних вложений: ${c.extras.unknown}` : null,
  ].filter(Boolean);
  return `состав не совпадает — ${parts.join('; ')}`;
};

const localNow = (): string => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

interface IRegisterSendDialogProps {
  releaseId: string;
  warnings: string[];
  onDone: () => void;
  onClose: () => void;
}

/**
 * Регистрация отправки выпуска (D-035): основание — отправленное письмо из почты портала (вложения сверяются с
 * комплектом по содержимому), файл или пояснение. Размещение не требуется — незавершённое показано предупреждением
 * (В-15-2). Отсутствие письма в списке не означает, что комплект не отправлен (A33).
 */
export const RegisterSendDialog: FC<IRegisterSendDialogProps> = ({ releaseId, warnings, onDone, onClose }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const [kind, setKind] = useState<TKind>('mail_message');
  const [revisionId, setRevisionId] = useState('');
  const [channel, setChannel] = useState<TSendChannel>('paper');
  const [sentAt, setSentAt] = useState(localNow);
  const [recipients, setRecipients] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const candidates = useApiResource((signal) => listSendCandidates(releaseId, signal), `send-candidates:${releaseId}`);
  const list = candidates.data?.items ?? [];

  const noteShort = kind === 'manual_note' && note.trim().length < 10;
  const invalid = kind === 'mail_message' ? revisionId === '' : sentAt === '' || noteShort || (kind === 'uploaded_file' && !file);

  const fail = (e: unknown): void => {
    setBusy(false);
    toast.push({ kind: 'error', text: describeError(e) });
  };
  const send = (body: TRegisterSendBody): void => {
    registerSend(releaseId, body, idem.keyFor(body)).then((r) => {
      idem.reset();
      setBusy(false);
      toast.push({ kind: r.status === 'disputed' ? 'error' : 'success', text: r.status === 'disputed' ? 'Отправка записана: состав письма не совпал с комплектом.' : 'Отправка зарегистрирована.' });
      onDone();
    }, fail);
  };
  const submit = (): void => {
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    if (kind === 'mail_message') return send({ evidence: { kind, mailMessageRevisionId: revisionId } });
    const manual = { channel, sentAt: new Date(sentAt).toISOString(), recipients: recipients.split('\n').map((x) => x.trim()).filter(Boolean), note: note.trim() || null };
    if (kind === 'manual_note') return send({ evidence: { kind }, ...manual });
    uploadSendEvidence(releaseId, file!, idem.keyFor({ upload: file!.name, size: file!.size })).promise.then((u) => {
      idem.reset();
      send({ evidence: { kind: 'uploaded_file', uploadId: u.uploadId }, ...manual });
    }, fail);
  };

  return (
    <Dialog
      title="Зарегистрировать отправку"
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy} autoFocus>
            Отмена
          </Button>
          <Button type="submit" variant="primary" icon="send" loading={busy}>
            Зарегистрировать
          </Button>
        </>
      }
    >
      <p className={styles.muted}>Запись фиксирует факт отправки. Получение и согласие заказчика она не подтверждает.</p>
      {warnings.map((w) => (
        <Notice key={w} tone="warning">{`${SEND_WARNING[w] ?? w}. Регистрации это не мешает: отправка — отдельный факт.`}</Notice>
      ))}
      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>Основание</legend>
        {KINDS.map((k) => (
          <label key={k.id} className={styles.choice}>
            <input type="radio" name="send-evidence" value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} />
            <span>{k.label}</span>
          </label>
        ))}
      </fieldset>
      {kind === 'mail_message' ? (
        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>Отправленные письма тендера</legend>
          {candidates.loading && !candidates.data ? <p className={styles.muted}>Загрузка писем…</p> : null}
          {candidates.data && list.length === 0 ? (
            <p className={styles.muted}>
              Отправленных писем, связанных с тендером, в ваших ящиках нет. Это не значит, что комплект не отправлен: импортируйте письмо (EML) в ящик с направлением «исходящее» и свяжите с тендером — либо зарегистрируйте отправку по файлу или пояснению.
            </p>
          ) : null}
          {list.map((c) => (
            <label key={c.revisionId} className={styles.choice}>
              <input type="radio" name="send-letter" value={c.revisionId} checked={revisionId === c.revisionId} disabled={!!c.registeredSendEventId || c.sentBeforeRelease} onChange={() => setRevisionId(c.revisionId)} />
              <span className={own.candidate}>
                <span>{`${c.subject ?? '(без темы)'} · ${formatDateTime(c.sentAt)}`}</span>
                <span className={styles.muted}>{`${c.mailboxName}${c.folder ? ` / ${c.folder}` : ''} · кому: ${c.recipients.join(', ') || '—'} · вложений: ${c.attachments}`}</span>
                <span className={styles.badges}>
                  <Badge label={candidateNote(c)} icon={c.check === 'matched' ? 'check' : 'file-exclamation-point'} tone={c.registeredSendEventId || c.sentBeforeRelease ? 'muted' : c.check === 'matched' ? 'success' : 'danger'} />
                </span>
              </span>
            </label>
          ))}
          {touched && revisionId === '' && list.length > 0 ? <p className={styles.error}>Выберите письмо</p> : null}
        </fieldset>
      ) : (
        <>
          <SelectField label="Канал" value={channel} onValueChange={(v) => setChannel(v as TSendChannel)} required options={Object.entries(SEND_CHANNEL).map(([value, label]) => ({ value, label }))} />
          <TextField label="Когда отправлено" type="datetime-local" value={sentAt} onValueChange={setSentAt} required error={touched && sentAt === '' ? 'Укажите время отправки' : undefined} />
          <TextAreaField label="Адресаты (по одному в строке)" value={recipients} onValueChange={setRecipients} rows={2} maxLength={4000} />
          {kind === 'uploaded_file' ? (
            <label className={own.file}>
              <span className={styles.label}>Файл-основание</span>
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <span className={styles.muted}>Файл увидят участники тендера, которым доступен выпуск. Состав отправки по нему не сверяется.</span>
              {touched && !file ? <span className={styles.error}>Выберите файл</span> : null}
            </label>
          ) : null}
          <TextAreaField
            label={kind === 'manual_note' ? 'Пояснение: как и что отправлено' : 'Пояснение'}
            value={note}
            onValueChange={setNote}
            required={kind === 'manual_note'}
            rows={3}
            maxLength={2000}
            error={touched && noteShort ? 'Пояснение — не короче 10 символов' : undefined}
          />
        </>
      )}
    </Dialog>
  );
};
