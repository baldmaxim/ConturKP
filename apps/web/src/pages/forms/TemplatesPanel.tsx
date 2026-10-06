import { useState, type ChangeEvent, type FC } from 'react';
import { describeError, fieldErrorsOf } from '../../api/errors';
import { approveTemplateRevision, createTemplate, createTemplateRevision, getTemplate, listTemplates } from '../../api/formsEndpoints';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import form from '../../styles/form.module.css';
import styles from './Forms.module.css';

const REVISION_STATUS: Record<string, string> = { draft: 'Черновик', approved: 'Утверждена', retired: 'Выведена' };

const TemplateRevisions: FC<{ templateId: string; canManage: boolean; onChanged: () => void }> = ({ templateId, canManage, onChanged }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const t = useApiResource((signal) => getTemplate(templateId, signal), templateId);
  const [busy, setBusy] = useState(false);
  const upload = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    file
      .text()
      .then((text) => createTemplateRevision(templateId, JSON.parse(text) as unknown, idem.keyFor({ templateId, name: file.name, size: file.size })))
      .then(
        () => {
          idem.reset();
          setBusy(false);
          toast.push({ kind: 'success', text: 'Ревизия схемы загружена: проверьте и утвердите' });
          t.reload();
          onChanged();
        },
        (err: unknown) => {
          setBusy(false);
          const fields = Object.values(fieldErrorsOf(err));
          toast.push({ kind: 'error', text: err instanceof SyntaxError ? 'Файл — не JSON' : fields.length ? `Схема не прошла проверку: ${fields.slice(0, 3).join('; ')}` : describeError(err) });
        },
      );
  };
  if (t.loading && !t.data) return <LoadingState />;
  if (t.error && !t.data) return <ErrorState error={t.error} onRetry={t.reload} />;
  return (
    <div className={styles.fields}>
      <ul className={styles.list}>
        {(t.data?.revisions ?? []).map((r) => (
          <li key={r.id} className={styles.row}>
            <Badge label={`№ ${r.seq} · ${REVISION_STATUS[r.status]}`} icon={r.status === 'approved' ? 'check' : 'circle-dot'} tone={r.status === 'approved' ? 'success' : 'muted'} />
            <span className={styles.muted}>{`${r.title} · полей ${r.fieldCount} · ${formatDateTime(r.createdAt)}`}</span>
            {canManage && r.status === 'draft' ? (
              <Button
                variant="primary"
                icon="check"
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  approveTemplateRevision(r, []).then(
                    () => {
                      setBusy(false);
                      toast.push({ kind: 'success', text: 'Ревизия утверждена' });
                      t.reload();
                      onChanged();
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
      {canManage ? (
        <label className={styles.row}>
          <span className={styles.muted}>Новая ревизия — файл схемы forms/1 (JSON):</span>
          <input type="file" accept="application/json,.json" onChange={upload} disabled={busy} />
        </label>
      ) : null}
    </div>
  );
};

/** Шаблоны компании (роль «руководитель») и заказчиков своих тендеров: ревизии схемы, загрузка и утверждение. */
export const TemplatesPanel: FC = () => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const list = useApiResource((signal) => listTemplates(null, signal), 'templates');
  const [name, setName] = useState('');
  const [demo, setDemo] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (list.loading && !list.data) return <LoadingState />;
  if (list.error && !list.data) return <ErrorState error={list.error} onRetry={list.reload} />;
  const items = list.data?.items ?? [];
  return (
    <section className={form.section} aria-labelledby="templates-title">
      <h2 id="templates-title" className={form.sectionTitle}>
        Шаблоны приложений
      </h2>
      {list.data?.canManageCompany ? (
        <form
          className={styles.row}
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            createTemplate({ ownerKind: 'company', name: name.trim(), isDemo: demo }, idem.keyFor({ name, demo })).then(
              (t) => {
                idem.reset();
                setBusy(false);
                setName('');
                setOpen(t.id);
                list.reload();
              },
              (err: unknown) => {
                setBusy(false);
                toast.push({ kind: 'error', text: describeError(err) });
              },
            );
          }}
        >
          <TextField label="Новый шаблон компании" value={name} onValueChange={setName} maxLength={300} />
          <label className={styles.row}>
            <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
            <span>Демонстрационный (не для выпуска)</span>
          </label>
          <Button type="submit" icon="plus" loading={busy} disabled={!name.trim()}>
            Создать
          </Button>
        </form>
      ) : null}
      {items.length === 0 ? <EmptyState icon="file-signature" title="Шаблонов нет" /> : null}
      <ul className={styles.list}>
        {items.map((t) => (
          <li key={t.id} className={styles.card}>
            <div className={styles.cardHead}>
              <p className={styles.label}>{t.name}</p>
              <div className={styles.badges}>
                <Badge label={t.ownerKind === 'company' ? 'Компании' : 'Заказчика'} icon="file-signature" tone="neutral" />
                {t.isDemo ? <Badge label="Демо — не для выпуска" icon="info" tone="warning" dashed /> : null}
                {t.currentSeq ? <Badge label={`Действует ревизия № ${t.currentSeq}`} icon="check" tone="success" /> : <Badge label="Нет утверждённой ревизии" icon="circle-dot" tone="muted" dashed />}
              </div>
            </div>
            <Button variant="ghost" icon="chevron-down" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
              Ревизии
            </Button>
            {open === t.id ? <TemplateRevisions templateId={t.id} canManage={t.canManage} onChanged={list.reload} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
};
