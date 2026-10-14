import { useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { registerIncident } from '../../api/sendEndpoints';
import type { IIncidentView } from '../../api/sendTypes';
import { uploadSendEvidence } from '../../api/upload';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { TextField } from '../../components/TextField';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { INCIDENT_KIND } from '../../utils/sendLabels';
import styles from '../release/Release.module.css';
import own from './Send.module.css';
import { isoToMoscowInput, moscowInputToIso } from '../../utils/datetime';

// Время вводится и показывается по Москве, как везде в портале (этап 17, S17-15): пояс браузера не участвует.
const localNow = (): string => isoToMoscowInput(new Date().toISOString());

interface IIncidentDialogProps {
  releaseId: string;
  testRelease: boolean;
  onDone: () => void;
  onClose: () => void;
}

/**
 * Нарушение: комплект ушёл заказчику вне системы — тестовый или тот, отправка которого удержана или исключена. Это
 * отдельная запись: отправкой она не становится и выпуск не подтверждает (RT-05). Начальный фокус — «Отмена».
 */
export const IncidentDialog: FC<IIncidentDialogProps> = ({ releaseId, testRelease, onDone, onClose }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const kinds: IIncidentView['kind'][] = testRelease ? ['test_release_sent_externally', 'other'] : ['sent_despite_blocker', 'other'];
  const [kind, setKind] = useState<IIncidentView['kind']>(kinds[0]!);
  const [occurredAt, setOccurredAt] = useState(localNow);
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const short = description.trim().length < 10;

  const fail = (e: unknown): void => {
    setBusy(false);
    toast.push({ kind: 'error', text: describeError(e) });
  };
  const occurredIso = moscowInputToIso(occurredAt);
  const send = (uploadId: string | null): void => {
    if (occurredIso === null) return;
    const body = { kind, occurredAt: occurredIso, description: description.trim(), uploadId };
    registerIncident(releaseId, body, idem.keyFor(body)).then(() => {
      idem.reset();
      setBusy(false);
      toast.push({ kind: 'success', text: 'Нарушение зарегистрировано.' });
      onDone();
    }, fail);
  };
  const submit = (): void => {
    setTouched(true);
    if (short || occurredIso === null) return;
    setBusy(true);
    if (!file) return send(null);
    uploadSendEvidence(releaseId, file, idem.keyFor({ upload: file.name, size: file.size })).promise.then((u) => {
      idem.reset();
      send(u.uploadId);
    }, fail);
  };

  return (
    <Dialog
      title="Зарегистрировать нарушение"
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy} autoFocus>
            Отмена
          </Button>
          <Button type="submit" variant="danger" icon="shield-x" loading={busy}>
            Зарегистрировать
          </Button>
        </>
      }
    >
      <p className={styles.muted}>Нарушение — не отправка: выпуск оно не подтверждает и его режим и готовность не меняет. Запись неизменна.</p>
      <SelectField label="Что произошло" value={kind} onValueChange={(v) => setKind(v as IIncidentView['kind'])} required options={kinds.map((k) => ({ value: k, label: INCIDENT_KIND[k]! }))} />
      <TextField label="Когда произошло, МСК" type="datetime-local" value={occurredAt} onValueChange={setOccurredAt} required error={touched && occurredIso === null ? 'Укажите время' : undefined} />
      <TextAreaField label="Описание" value={description} onValueChange={setDescription} required rows={3} maxLength={4000} error={touched && short ? 'Описание — не короче 10 символов' : undefined} />
      <label className={own.file}>
        <span className={styles.label}>Файл-основание (по желанию)</span>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
    </Dialog>
  );
};
