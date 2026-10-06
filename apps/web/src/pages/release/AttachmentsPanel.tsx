import { useState, type ChangeEvent, type FC } from 'react';
import { describeError } from '../../api/errors';
import { approveAttachmentRevision, createAttachment, createAttachmentRevision, listAttachments } from '../../api/releaseEndpoints';
import { uploadFormSample } from '../../api/upload';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatBytes } from '../../utils/releaseLabels';
import form from '../../styles/form.module.css';
import styles from './Release.module.css';

const STATUS: Record<string, string> = { draft: 'Черновик', approved: 'Утверждена', retired: 'Выведена' };

/**
 * Библиотека стандартных вложений (D-032 В-12-4): файл «как есть» (DOCX, XLSX, DOC, PDF) с ревизиями; ведёт роль
 * «руководитель»; утверждённые ревизии выбираются при сборке комплекта.
 */
export const AttachmentsPanel: FC = () => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const list = useApiResource((signal) => listAttachments(signal), 'attachments-library');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [audience, setAudience] = useState<'customer' | 'internal'>('customer');
  const [busy, setBusy] = useState(false);
  // Форма нового вложения раскрывается кнопкой: до действия на странице нет лишнего поля выбора файла.
  const [open, setOpen] = useState(false);
  if (list.loading && !list.data) return <LoadingState />;
  if (list.error && !list.data) return <ErrorState error={list.error} onRetry={list.reload} />;
  const items = list.data?.items ?? [];
  const add = async (): Promise<void> => {
    if (!file || !title.trim()) return;
    setBusy(true);
    try {
      const a = await createAttachment(title.trim(), idem.keyFor({ title, kind: 'attachment' }));
      const up = await uploadFormSample(file, idem.keyFor({ file: file.name, size: file.size, kind: 'attachment-file' })).promise;
      await createAttachmentRevision(a.id, { sha256: up.sha256, fileName: file.name, audience }, idem.keyFor({ attachment: a.id, sha: up.sha256 }));
      idem.reset();
      setTitle('');
      setFile(null);
      setOpen(false);
      toast.push({ kind: 'success', text: 'Вложение загружено: утвердите ревизию' });
      list.reload();
    } catch (err: unknown) {
      toast.push({ kind: 'error', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={form.section} aria-labelledby="attachments-title">
      <h2 id="attachments-title" className={form.sectionTitle}>
        Стандартные вложения комплекта
      </h2>
      {list.data?.canCreateCompany && !open ? (
        <div className={styles.actions}>
          <Button icon="paperclip" onClick={() => setOpen(true)}>
            Новое вложение
          </Button>
        </div>
      ) : null}
      {list.data?.canCreateCompany && open ? (
        <div className={styles.fieldset}>
          <TextField label="Название вложения" value={title} onValueChange={setTitle} maxLength={300} />
          <label className={styles.choice}>
            <span className={styles.muted}>Файл (DOCX, XLSX, DOC или PDF — «как есть»):</span>
            <input type="file" accept=".docx,.xlsx,.doc,.pdf" onChange={(e: ChangeEvent<HTMLInputElement>) => setFile(e.target.files?.[0] ?? null)} disabled={busy} />
          </label>
          <SelectField
            label="Аудитория"
            value={audience}
            options={[
              { value: 'customer', label: 'Заказчику' },
              { value: 'internal', label: 'Внутреннее' },
            ]}
            onValueChange={(v) => setAudience(v === 'internal' ? 'internal' : 'customer')}
          />
          <div className={styles.actions}>
            <Button icon="paperclip" loading={busy} disabled={!file || !title.trim()} onClick={() => void add()}>
              Добавить вложение
            </Button>
            <Button icon="x" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Отмена
            </Button>
          </div>
        </div>
      ) : null}
      {items.length === 0 ? <EmptyState icon="paperclip" title="Вложений нет" text="Например, руководство по эксплуатации или перечень исполнительной документации." /> : null}
      <ul className={styles.list}>
        {items.map((a) => (
          <li key={a.revisionId} className={styles.fileRow}>
            <span className={styles.label}>{`${a.title} · ревизия № ${a.seq}`}</span>
            <span className={styles.badges}>
              <Badge label={STATUS[a.status] ?? a.status} icon={a.status === 'approved' ? 'check' : 'circle-dot'} tone={a.status === 'approved' ? 'success' : 'muted'} />
              <Badge label={a.audience === 'internal' ? 'Внутреннее' : 'Заказчику'} icon="files" tone="neutral" />
              {a.scopeTenderId ? <Badge label="Тендера" icon="briefcase" tone="neutral" /> : <Badge label="Компании" icon="briefcase" tone="neutral" />}
            </span>
            <span className={styles.muted}>{`${a.fileName} · ${formatBytes(a.sizeBytes)} · SHA-256 ${a.sha256.slice(0, 12)}…`}</span>
            {a.canManage && a.status === 'draft' ? (
              <Button
                variant="primary"
                icon="check"
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  approveAttachmentRevision(a).then(
                    () => {
                      setBusy(false);
                      toast.push({ kind: 'success', text: 'Вложение утверждено' });
                      list.reload();
                    },
                    (err: unknown) => {
                      setBusy(false);
                      toast.push({ kind: 'error', text: describeError(err) });
                    },
                  );
                }}
              >
                Утвердить
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
};
