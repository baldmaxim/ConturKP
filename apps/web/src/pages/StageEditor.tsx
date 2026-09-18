import { useState, type FC } from 'react';
import { getStage, updateStage } from '../api/endpoints';
import { conflictCurrent, describeError, fieldErrorsOf, hasCode } from '../api/errors';
import { isStage } from '../api/guards';
import type { IStage, IStagePatch } from '../api/types';
import { Button } from '../components/Button';
import { ConflictDialog, type IConflictRow } from '../components/ConflictDialog';
import { Notice } from '../components/Notice';
import { StatusBadge } from '../components/StatusBadge';
import { TextField } from '../components/TextField';
import { useToast } from '../hooks/useToast';
import { useUnsavedChanges } from '../hooks/unsavedChanges';
import { formatDateTime, isoToMoscowInput, moscowInputToIso } from '../utils/datetime';
import form from '../styles/form.module.css';

interface IStageForm {
  title: string;
  /** Значение datetime-local по Москве. */
  deadline: string;
}

const toForm = (stage: IStage): IStageForm => ({
  title: stage.title,
  deadline: isoToMoscowInput(stage.submissionDeadline),
});

const sameInstant = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) {
    return a === b;
  }
  return new Date(a).getTime() === new Date(b).getTime();
};

const deadlineLabel = (iso: string | null): string => (iso ? `${formatDateTime(iso)} МСК` : 'срок не задан');

interface IStageEditorProps {
  stage: IStage;
  canWrite: boolean;
  onChanged: (stage: IStage) => void;
}

export const StageEditor: FC<IStageEditorProps> = ({ stage, canWrite, onChanged }) => {
  const toast = useToast();
  const [base, setBase] = useState<IStage | null>(null);
  const [values, setValues] = useState<IStageForm>(() => toForm(stage));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ current: IStage | null } | null>(null);
  const [reloading, setReloading] = useState(false);

  const editing = base !== null;
  const deadlineIso = values.deadline ? moscowInputToIso(values.deadline) : null;
  const titleChanged = editing && values.title.trim() !== base.title;
  const deadlineChanged = editing && !sameInstant(deadlineIso, base.submissionDeadline);
  const dirty = titleChanged || deadlineChanged;
  useUnsavedChanges(dirty);

  const startEdit = (): void => {
    setBase(stage);
    setValues(toForm(stage));
    setErrors({});
    setFormError(null);
  };

  const cancelEdit = (): void => {
    setBase(null);
    setErrors({});
    setFormError(null);
  };

  const save = async (): Promise<void> => {
    if (!base) {
      return;
    }
    const nextErrors: Record<string, string> = {};
    if (!values.title.trim()) {
      nextErrors.title = 'Укажите название этапа.';
    }
    if (values.deadline && !deadlineIso) {
      nextErrors.submissionDeadline = 'Укажите дату и время полностью.';
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    const patch: IStagePatch = {};
    if (titleChanged) {
      patch.title = values.title.trim();
    }
    if (deadlineChanged) {
      patch.submissionDeadline = deadlineIso;
    }
    if (Object.keys(patch).length === 0) {
      cancelEdit();
      return;
    }
    setSaving(true);
    try {
      const updated = await updateStage(base.id, base.rowVersion, patch);
      onChanged(updated);
      setBase(null);
      toast.push({ kind: 'success', text: 'Этап сохранён.' });
    } catch (error) {
      if (hasCode(error, 'VERSION_CONFLICT')) {
        setConflict({ current: conflictCurrent(error, isStage) });
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
      const current = conflict?.current ?? (await getStage(stage.id));
      onChanged(current);
      setBase(current);
      setValues(toForm(current));
      setConflict(null);
    } catch (error) {
      toast.push({ kind: 'error', text: `Не удалось перечитать этап: ${describeError(error)}` });
    } finally {
      setReloading(false);
    }
  };

  const conflictRows: IConflictRow[] = conflict?.current
    ? [
        { label: 'Название', mine: values.title.trim(), current: conflict.current.title },
        {
          label: 'Срок подачи',
          mine: deadlineIso ? deadlineLabel(deadlineIso) : values.deadline ? values.deadline : 'срок не задан',
          current: deadlineLabel(conflict.current.submissionDeadline),
        },
      ]
    : [];

  return (
    <section className={form.section} aria-labelledby="stage-title">
      <div className={form.sectionHead}>
        <h2 id="stage-title" className={form.sectionTitle}>
          Параметры этапа
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
            <TextField label="Название" required value={values.title} onValueChange={(v) => setValues((p) => ({ ...p, title: v }))} error={errors.title} />
            <TextField
              label="Срок подачи, МСК"
              type="datetime-local"
              value={values.deadline}
              onValueChange={(v) => setValues((p) => ({ ...p, deadline: v }))}
              error={errors.submissionDeadline}
              hint="Время по Москве. Очистите поле, чтобы снять срок."
            />
          </div>
          <div className={form.actions}>
            <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
              Отмена
            </Button>
            <Button variant="primary" type="submit" loading={saving} disabled={!dirty}>
              Сохранить
            </Button>
          </div>
        </form>
      ) : (
        <dl className={form.details}>
          <dt>Номер</dt>
          <dd className={form.num}>№ {stage.seq}</dd>
          <dt>Название</dt>
          <dd>{stage.title}</dd>
          <dt>Срок подачи</dt>
          <dd className={form.num}>
            {stage.submissionDeadline ? deadlineLabel(stage.submissionDeadline) : <span className={form.absent}>срок не задан</span>}
          </dd>
          <dt>Статус</dt>
          <dd>
            <StatusBadge status={stage.status} />
          </dd>
          <dt>Версия входных данных</dt>
          <dd className={form.num}>{stage.inputVersion}</dd>
          <dt>Создан</dt>
          <dd className={form.num}>{formatDateTime(stage.createdAt)} МСК</dd>
          <dt>Изменён</dt>
          <dd className={form.num}>{formatDateTime(stage.updatedAt)} МСК</dd>
        </dl>
      )}

      {conflict ? (
        <ConflictDialog
          title="Этап изменён другим пользователем"
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
