import { useState, type FC } from 'react';
import { conflictCurrent, describeError, fieldErrorsOf, hasCode } from '../../api/errors';
import { isDocument } from '../../api/guards';
import { getDocument, updateDocument } from '../../api/sourceEndpoints';
import type { IDocument, IDocumentPatch, TDocType } from '../../api/types';
import { Button } from '../../components/Button';
import { ConflictDialog, type IConflictRow } from '../../components/ConflictDialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { TextField } from '../../components/TextField';
import { useToast } from '../../hooks/useToast';
import { useUnsavedChanges } from '../../hooks/unsavedChanges';
import { formatDateTime } from '../../utils/datetime';
import { DOC_TYPE_LABELS, DOC_TYPES, docTypeLabel } from '../../utils/sourceLabels';
import form from '../../styles/form.module.css';

interface IDocForm {
  title: string;
  docType: TDocType;
  docCode: string;
  scopeNote: string;
}

const toForm = (doc: IDocument): IDocForm => ({
  title: doc.title,
  docType: doc.docType,
  docCode: doc.docCode ?? '',
  scopeNote: doc.scopeNote ?? '',
});

const orNull = (value: string): string | null => (value.trim() ? value.trim() : null);

const DOC_TYPE_OPTIONS = DOC_TYPES.map((value) => ({ value, label: DOC_TYPE_LABELS[value] }));

interface IDocumentMetaEditorProps {
  doc: IDocument;
  canWrite: boolean;
  onChanged: (doc: IDocument) => void;
}

/** Метаданные документа: название, тип, шифр, область применения. 412 — диалог конфликта. */
export const DocumentMetaEditor: FC<IDocumentMetaEditorProps> = ({ doc, canWrite, onChanged }) => {
  const toast = useToast();
  const [base, setBase] = useState<IDocument | null>(null);
  const [values, setValues] = useState<IDocForm>(() => toForm(doc));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ current: IDocument | null } | null>(null);
  const [reloading, setReloading] = useState(false);

  const buildPatch = (from: IDocument): IDocumentPatch => {
    const patch: IDocumentPatch = {};
    if (values.title.trim() !== from.title) {
      patch.title = values.title.trim();
    }
    if (values.docType !== from.docType) {
      patch.docType = values.docType;
    }
    if (orNull(values.docCode) !== from.docCode) {
      patch.docCode = orNull(values.docCode);
    }
    if (orNull(values.scopeNote) !== from.scopeNote) {
      patch.scopeNote = orNull(values.scopeNote);
    }
    return patch;
  };

  const editing = base !== null;
  const dirty = editing && Object.keys(buildPatch(base)).length > 0;
  useUnsavedChanges(dirty);

  const set = (key: 'title' | 'docCode' | 'scopeNote') => (value: string) => setValues((prev) => ({ ...prev, [key]: value }));
  const setDocType = (value: string): void =>
    setValues((prev) => ({ ...prev, docType: DOC_TYPES.find((type) => type === value) ?? prev.docType }));

  const startEdit = (): void => {
    setBase(doc);
    setValues(toForm(doc));
    setErrors({});
    setFormError(null);
  };

  const save = async (): Promise<void> => {
    if (!base) {
      return;
    }
    if (!values.title.trim()) {
      setErrors({ title: 'Укажите название документа.' });
      return;
    }
    setErrors({});
    setFormError(null);
    const patch = buildPatch(base);
    if (Object.keys(patch).length === 0) {
      setBase(null);
      return;
    }
    setSaving(true);
    try {
      const updated = await updateDocument(base.id, base.rowVersion, patch);
      onChanged(updated);
      setBase(null);
      toast.push({ kind: 'success', text: 'Документ сохранён.' });
    } catch (error) {
      if (hasCode(error, 'VERSION_CONFLICT')) {
        setConflict({ current: conflictCurrent(error, isDocument) });
      } else {
        setErrors(fieldErrorsOf(error));
        setFormError(describeError(error));
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadAfterConflict = async (): Promise<void> => {
    setReloading(true);
    try {
      const current = conflict?.current ?? (await getDocument(doc.id));
      onChanged(current);
      setBase(current);
      setValues(toForm(current));
      setConflict(null);
    } catch (error) {
      toast.push({ kind: 'error', text: `Не удалось перечитать документ: ${describeError(error)}` });
    } finally {
      setReloading(false);
    }
  };

  const conflictRows: IConflictRow[] = conflict?.current
    ? [
        { label: 'Название', mine: values.title.trim(), current: conflict.current.title },
        { label: 'Тип', mine: docTypeLabel(values.docType), current: docTypeLabel(conflict.current.docType) },
        { label: 'Шифр', mine: values.docCode.trim(), current: conflict.current.docCode ?? '' },
        { label: 'Область применения', mine: values.scopeNote.trim(), current: conflict.current.scopeNote ?? '' },
      ]
    : [];

  return (
    <section className={form.section} aria-labelledby="doc-meta-title">
      <div className={form.sectionHead}>
        <h2 id="doc-meta-title" className={form.sectionTitle}>
          Карточка документа
        </h2>
        {canWrite && !editing ? (
          <Button icon="pencil" onClick={startEdit}>
            Изменить
          </Button>
        ) : null}
      </div>

      {editing ? (
        <form
          className={form.stack}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {formError ? <Notice tone="danger">{formError}</Notice> : null}
          <div className={form.grid}>
            <div className={form.wide}>
              <TextField label="Название" required value={values.title} onValueChange={set('title')} error={errors.title} maxLength={500} />
            </div>
            <SelectField label="Тип документа" value={values.docType} options={DOC_TYPE_OPTIONS} onValueChange={setDocType} error={errors.docType} />
            <TextField label="Шифр" value={values.docCode} onValueChange={set('docCode')} error={errors.docCode} maxLength={100} autoComplete="off" />
            <div className={form.wide}>
              <TextAreaField
                label="Область применения"
                value={values.scopeNote}
                onValueChange={set('scopeNote')}
                error={errors.scopeNote}
                maxLength={2000}
                hint="К какой части объекта или работ относится документ."
              />
            </div>
          </div>
          <div className={form.actions}>
            <Button variant="ghost" onClick={() => setBase(null)} disabled={saving}>
              Отмена
            </Button>
            <Button variant="primary" type="submit" loading={saving} disabled={!dirty}>
              Сохранить
            </Button>
          </div>
        </form>
      ) : (
        <dl className={form.details}>
          <dt>Название</dt>
          <dd>{doc.title}</dd>
          <dt>Тип</dt>
          <dd>{docTypeLabel(doc.docType)}</dd>
          <dt>Шифр</dt>
          <dd className={doc.docCode ? form.mono : form.absent}>{doc.docCode ?? 'не указан'}</dd>
          <dt>Область применения</dt>
          <dd className={doc.scopeNote ? undefined : form.absent}>{doc.scopeNote ?? 'не указана'}</dd>
          <dt>Редакций</dt>
          <dd className={form.num}>{doc.revisions}</dd>
          <dt>Изменён</dt>
          <dd className={form.num}>{formatDateTime(doc.updatedAt)} МСК</dd>
        </dl>
      )}

      {conflict ? (
        <ConflictDialog
          title="Документ изменён другим пользователем"
          rows={conflictRows}
          currentUnknown={!conflict.current}
          reloading={reloading}
          onReload={() => void reloadAfterConflict()}
          onClose={() => setConflict(null)}
        />
      ) : null}
    </section>
  );
};
