import { useState, type ChangeEvent, type FC } from 'react';
import { describeError, fieldErrorsOf } from '../../api/errors';
import { approveTemplateRevision, createTemplate, createTemplateRevision, getTemplate, listTemplates } from '../../api/formsEndpoints';
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
import { formatDateTime } from '../../utils/datetime';
import form from '../../styles/form.module.css';
import styles from './Forms.module.css';

const REVISION_STATUS: Record<string, string> = { draft: 'Черновик', approved: 'Утверждена', retired: 'Выведена' };

const MARKUP_ISSUE_LIMIT = 8;

// Новая ревизия. Простой путь (этап 11): выбор файла схемы forms/1 сразу создаёт ревизию. С образцом для генерации
// (D-032 В-12-3): оригинал образца, размеченная копия с {{ключами}} и аудитория выбираются вместе со схемой, ревизия
// создаётся кнопкой — размеченная копия задаётся только при создании ревизии и потом не меняется.
const NewRevision: FC<{ templateId: string; onCreated: () => void }> = ({ templateId, onCreated }) => {
  const toast = useToast();
  const idem = useIdempotencyKey();
  const [withSample, setWithSample] = useState(false);
  const [schemaFile, setSchemaFile] = useState<File | null>(null);
  const [original, setOriginal] = useState<File | null>(null);
  const [marked, setMarked] = useState<File | null>(null);
  const [audience, setAudience] = useState<'customer' | 'internal'>('customer');
  const [busy, setBusy] = useState(false);
  const pick = (set: (f: File | null) => void) => (e: ChangeEvent<HTMLInputElement>) => set(e.target.files?.[0] ?? null);
  const submit = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const schema = JSON.parse(await file.text()) as unknown;
      const up = async (f: File | null) => (f ? { sha256: (await uploadFormSample(f, idem.keyFor({ templateId, file: f.name, size: f.size, kind: 'sample' })).promise).sha256, name: f.name } : null);
      const sample = withSample ? await up(original) : null;
      const markedSample = withSample ? await up(marked) : null;
      const r = await createTemplateRevision(
        templateId,
        schema,
        idem.keyFor({ templateId, schema: file.name, size: file.size, marked: markedSample?.sha256 ?? null, audience }),
        withSample ? { sample, markedSample, audience } : {},
      );
      idem.reset();
      toast.push({ kind: r.markup && !r.markup.ok ? 'error' : 'success', text: r.markup ? (r.markup.ok ? 'Ревизия загружена, разметка образца проверена' : 'Ревизия загружена, но в разметке есть ошибки: её нельзя утвердить') : 'Ревизия схемы загружена: проверьте и утвердите' });
      onCreated();
    } catch (err: unknown) {
      const fields = Object.values(fieldErrorsOf(err));
      toast.push({ kind: 'error', text: err instanceof SyntaxError ? 'Файл схемы — не JSON' : fields.length ? `Не прошло проверку: ${fields.slice(0, 3).join('; ')}` : describeError(err) });
    } finally {
      setBusy(false);
    }
  };
  const onSchema = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0] ?? null;
    if (!withSample) {
      e.target.value = '';
      if (file) void submit(file);
      return;
    }
    setSchemaFile(file);
  };
  return (
    <div className={styles.fields}>
      <label className={styles.row}>
        <span className={styles.muted}>{withSample ? 'Схема forms/1 (JSON):' : 'Новая ревизия — файл схемы forms/1 (JSON):'}</span>
        <input type="file" accept="application/json,.json" onChange={onSchema} disabled={busy} />
      </label>
      <label className={styles.toggle}>
        <input type="checkbox" checked={withSample} onChange={(e) => setWithSample(e.target.checked)} disabled={busy} />
        <span>С образцом для генерации файла (DOCX или XLSX)</span>
      </label>
      {withSample ? (
        <>
          <label className={styles.row}>
            <span className={styles.muted}>Оригинал образца (сохраняется как есть):</span>
            <input type="file" accept=".docx,.xlsx" onChange={pick(setOriginal)} disabled={busy} />
          </label>
          <label className={styles.row}>
            <span className={styles.muted}>Размеченная копия с {'{{ключами}}'} (DOCX или XLSX):</span>
            <input type="file" accept=".docx,.xlsx" onChange={pick(setMarked)} disabled={busy} />
          </label>
          <SelectField
            label="Аудитория файла"
            value={audience}
            options={[
              { value: 'customer', label: 'Заказчику' },
              { value: 'internal', label: 'Внутреннее' },
            ]}
            onValueChange={(v) => setAudience(v === 'internal' ? 'internal' : 'customer')}
          />
          <Button icon="upload" loading={busy} disabled={!schemaFile || !marked} onClick={() => schemaFile && void submit(schemaFile)}>
            Загрузить ревизию
          </Button>
        </>
      ) : null}
    </div>
  );
};

const TemplateRevisions: FC<{ templateId: string; canManage: boolean; onChanged: () => void }> = ({ templateId, canManage, onChanged }) => {
  const toast = useToast();
  const t = useApiResource((signal) => getTemplate(templateId, signal), templateId);
  const [busy, setBusy] = useState(false);
  if (t.loading && !t.data) return <LoadingState />;
  if (t.error && !t.data) return <ErrorState error={t.error} onRetry={t.reload} />;
  return (
    <div className={styles.fields}>
      <ul className={styles.list}>
        {(t.data?.revisions ?? []).map((r) => (
          <li key={r.id} className={styles.fields}>
            <div className={styles.row}>
              <Badge label={`№ ${r.seq} · ${REVISION_STATUS[r.status]}`} icon={r.status === 'approved' ? 'check' : 'circle-dot'} tone={r.status === 'approved' ? 'success' : 'muted'} />
              {r.markup ? (
                <Badge label={r.markup.ok ? `Разметка ${r.outputFormat?.toUpperCase() ?? ''} проверена` : `Ошибки разметки: ${r.markup.issues.length}`} icon={r.markup.ok ? 'check' : 'circle-x'} tone={r.markup.ok ? 'success' : 'danger'} />
              ) : (
                <Badge label="Без размеченного образца — файл не генерируется" icon="info" tone="muted" dashed />
              )}
              {r.markup ? <Badge label={r.audience === 'internal' ? 'Внутреннее' : 'Заказчику'} icon="files" tone="neutral" /> : null}
              <span className={styles.muted}>{`${r.title} · полей ${r.fieldCount} · ${formatDateTime(r.createdAt)}`}</span>
              {canManage && r.status === 'draft' && (!r.markup || r.markup.ok) ? (
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
            </div>
            {r.markup && !r.markup.ok ? (
              <ul className={styles.issues} aria-label="Ошибки разметки образца">
                {r.markup.issues.slice(0, MARKUP_ISSUE_LIMIT).map((i, n) => (
                  <li key={n} className={styles.muted}>{`${i.where ? `${i.where}: ` : ''}${i.message}`}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <NewRevision
          templateId={templateId}
          onCreated={() => {
            t.reload();
            onChanged();
          }}
        />
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
