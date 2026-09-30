import { useRef, useState, type ChangeEvent, type FC } from 'react';
import { newUuid } from '../../api/client';
import { describeError } from '../../api/errors';
import { listMailImports } from '../../api/mailEndpoints';
import type { IMailbox, IMailImport, TMailDirection } from '../../api/mailTypes';
import { uploadEml } from '../../api/upload';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { DIRECTION_LABELS, IMPORT_FAILURE_LABELS } from '../../utils/mailLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './Mail.module.css';

interface IMailImportPanelProps {
  mailbox: IMailbox;
  onImported: () => void;
}

const statusBadge = (i: IMailImport) => {
  if (i.status === 'queued') return <Badge tone="info" icon="hourglass" dashed label="Разбирается" />;
  if (i.status === 'failed') return <Badge tone="danger" icon="circle-x" label="Отказ разбора" />;
  return i.createdRevision ? <Badge tone="success" icon="check" label="Новая ревизия" /> : <Badge tone="neutral" icon="copy" label="Уже было" />;
};

/**
 * Ручной импорт EML (OD-07-4, AD-07-3): штатный путь, пока MailHub не открыт для машинного чтения (X-03).
 * Файл принимает сервер, разбирает worker; побайтный повтор даёт прежнюю ревизию, изменённая копия с тем же
 * Message-ID — новую. Отправленные письма импортируются с направлением «Отправленное».
 */
export const MailImportPanel: FC<IMailImportPanelProps> = ({ mailbox, onImported }) => {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const importsRes = useApiResource((signal) => listMailImports(mailbox.id, signal), `imports:${mailbox.id}`);
  const [direction, setDirection] = useState<TMailDirection>('inbound');
  const [folder, setFolder] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canImport = mailbox.capabilities.includes('mail.import') && mailbox.status === 'active';
  const items = importsRes.data?.items ?? [];
  const pending = items.some((i) => i.status === 'queued');

  usePolling(pending, () => {
    importsRes.reload();
    onImported();
  });

  const onPick = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length === 0) return;
    setError(null);
    let accepted = 0;
    for (const [index, file] of files.entries()) {
      setProgress(`${index + 1} из ${files.length}`);
      try {
        await uploadEml(mailbox.id, file, { direction, folder: folder.trim() || null, tenderId: null, stageId: null }, newUuid(), () => undefined).promise;
        accepted += 1;
      } catch (e) {
        setError(`${file.name}: ${describeError(e)}`);
      }
    }
    setProgress(null);
    if (accepted > 0) toast.push({ kind: 'success', text: `Принято писем: ${accepted}. Разбор идёт в фоне.` });
    importsRes.reload();
  };

  if (importsRes.loading && !importsRes.data) return <LoadingState />;
  if (importsRes.error) return <ErrorState error={importsRes.error} onRetry={importsRes.reload} />;

  return (
    <div className={form.stack}>
      {canImport ? (
        <section className={form.section} aria-labelledby="eml-upload">
          <div className={form.sectionHead}>
            <h2 id="eml-upload" className={form.sectionTitle}>
              Импорт писем EML
            </h2>
          </div>
          <div className={form.grid}>
            <SelectField
              label="Направление"
              value={direction}
              options={(['inbound', 'outbound', 'unknown'] as const).map((d) => ({ value: d, label: DIRECTION_LABELS[d] }))}
              onValueChange={(v) => setDirection(v as TMailDirection)}
              hint="Отправленные письма выгружайте отдельно: общая лента их может не содержать."
            />
            <TextField label="Папка" value={folder} onValueChange={setFolder} autoComplete="off" hint="Необязательно: например, «Входящие»." />
          </div>
          <input ref={inputRef} className={styles.fileInput} type="file" accept=".eml,message/rfc822" multiple onChange={(e) => void onPick(e)} />
          <div className={form.actions}>
            <Button variant="primary" icon="upload" loading={progress !== null} onClick={() => inputRef.current?.click()}>
              {progress !== null ? `Отправка ${progress}` : 'Выбрать файлы .eml'}
            </Button>
          </div>
          <p className={list.muted}>Повтор того же файла новой ревизии не создаёт. Письмо не помечается прочитанным и никуда не перемещается.</p>
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </section>
      ) : (
        <Notice tone="info">{mailbox.status === 'archived' ? 'Ящик в архиве: импорт не принимается.' : 'Импорт писем доступен с правом «Импорт EML».'}</Notice>
      )}
      {items.length === 0 ? (
        <EmptyState icon="upload" title="Импортов пока нет" text="Здесь появятся загруженные файлы EML и итог их разбора." />
      ) : (
        <ul className={styles.cards}>
          {items.map((i) => (
            <li key={i.id} className={list.card}>
              <div className={list.cardHead}>
                <span className={list.cardTitle}>{i.fileName}</span>
                {statusBadge(i)}
              </div>
              <dl className={list.meta}>
                <dt>Загружен</dt>
                <dd className={list.num}>{`${formatDateTime(i.createdAt)} МСК`}</dd>
                <dt>Направление</dt>
                <dd>{DIRECTION_LABELS[i.direction]}</dd>
                {i.status === 'failed' ? (
                  <>
                    <dt>Причина</dt>
                    <dd>{IMPORT_FAILURE_LABELS[i.failureCode ?? ''] ?? i.failureDetail ?? i.failureCode}</dd>
                  </>
                ) : null}
              </dl>
              {i.messageId ? (
                <AppLink className={list.rowLink} to={`/mail-messages/${i.messageId}`}>
                  Открыть письмо
                </AppLink>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
