import { useState, type FC } from 'react';
import { getTender, updateTender } from '../api/endpoints';
import { conflictCurrent, describeError, fieldErrorsOf, hasCode } from '../api/errors';
import { isTender } from '../api/guards';
import type { ITender, ITenderPatch, TTenderStatus } from '../api/types';
import { Button } from '../components/Button';
import { ConflictDialog, type IConflictRow } from '../components/ConflictDialog';
import { Notice } from '../components/Notice';
import { SelectField } from '../components/SelectField';
import { StatusBadge } from '../components/StatusBadge';
import { TextField } from '../components/TextField';
import { useToast } from '../hooks/useToast';
import { useUnsavedChanges } from '../hooks/unsavedChanges';
import { formatDateTime } from '../utils/datetime';
import { MEMBER_ROLE_LABELS } from '../utils/labels';
import form from '../styles/form.module.css';

interface ITenderForm {
  title: string;
  customerName: string;
  objectName: string;
  status: TTenderStatus;
}

const STATUS_LABELS: Record<TTenderStatus, string> = { active: 'Действующий', archived: 'В архиве' };

const toForm = (tender: ITender): ITenderForm => ({
  title: tender.title,
  customerName: tender.customerName ?? '',
  objectName: tender.objectName ?? '',
  status: tender.status,
});

const buildPatch = (base: ITender, values: ITenderForm): ITenderPatch => {
  const patch: ITenderPatch = {};
  if (values.title.trim() !== base.title) {
    patch.title = values.title.trim();
  }
  const customer = values.customerName.trim() || null;
  if (customer !== base.customerName) {
    patch.customerName = customer;
  }
  const object = values.objectName.trim() || null;
  if (object !== base.objectName) {
    patch.objectName = object;
  }
  if (values.status !== base.status) {
    patch.status = values.status;
  }
  return patch;
};

interface IConflictState {
  current: ITender | null;
}

interface ITenderCardProps {
  tender: ITender;
  onChanged: (tender: ITender) => void;
}

export const TenderCard: FC<ITenderCardProps> = ({ tender, onChanged }) => {
  const toast = useToast();
  const canEdit = tender.capabilities.includes('admin.tender');
  const isMember = tender.capabilities.includes('tender.read');
  const [base, setBase] = useState<ITender | null>(null);
  const [values, setValues] = useState<ITenderForm>(() => toForm(tender));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<IConflictState | null>(null);
  const [reloading, setReloading] = useState(false);

  const editing = base !== null;
  const dirty = editing && Object.keys(buildPatch(base, values)).length > 0;
  useUnsavedChanges(dirty);

  const set = <K extends keyof ITenderForm>(key: K, value: ITenderForm[K]): void =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const startEdit = (): void => {
    setBase(tender);
    setValues(toForm(tender));
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
    if (!values.title.trim()) {
      setErrors({ title: 'Укажите название.' });
      return;
    }
    const patch = buildPatch(base, values);
    if (Object.keys(patch).length === 0) {
      cancelEdit();
      return;
    }
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const updated = await updateTender(base.id, base.rowVersion, patch);
      onChanged(updated);
      setBase(null);
      toast.push({ kind: 'success', text: 'Карточка тендера сохранена.' });
    } catch (error) {
      if (hasCode(error, 'VERSION_CONFLICT')) {
        setConflict({ current: conflictCurrent(error, isTender) });
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
      const current = conflict?.current ?? (await getTender(tender.id));
      onChanged(current);
      setBase(current);
      setValues(toForm(current));
      setConflict(null);
    } catch (error) {
      toast.push({ kind: 'error', text: `Не удалось перечитать тендер: ${describeError(error)}` });
    } finally {
      setReloading(false);
    }
  };

  const conflictRows: IConflictRow[] = conflict?.current
    ? [
        { label: 'Название', mine: values.title.trim(), current: conflict.current.title },
        { label: 'Заказчик', mine: values.customerName.trim(), current: conflict.current.customerName ?? '' },
        { label: 'Объект', mine: values.objectName.trim(), current: conflict.current.objectName ?? '' },
        { label: 'Статус', mine: STATUS_LABELS[values.status], current: STATUS_LABELS[conflict.current.status] },
      ]
    : [];

  const absent = <span className={form.absent}>не указан</span>;

  return (
    <section className={form.section} aria-labelledby="tender-card-title">
      <div className={form.sectionHead}>
        <h2 id="tender-card-title" className={form.sectionTitle}>
          Карточка тендера
        </h2>
        {canEdit && !editing ? (
          <Button icon="pencil" onClick={startEdit}>
            Изменить
          </Button>
        ) : null}
      </div>

      {!isMember ? (
        <Notice tone="info">Вы не участник этого тендера: этапы и журнал тендера доступны только его участникам.</Notice>
      ) : null}

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
            <TextField label="Код" value={tender.code} onValueChange={() => undefined} readOnly hint="Код тендера не меняется." />
            <SelectField
              label="Статус"
              value={values.status}
              options={[
                { value: 'active', label: STATUS_LABELS.active },
                { value: 'archived', label: STATUS_LABELS.archived },
              ]}
              onValueChange={(value) => set('status', value === 'archived' ? 'archived' : 'active')}
              error={errors.status}
            />
            <div className={form.wide}>
              <TextField label="Название" required value={values.title} onValueChange={(v) => set('title', v)} error={errors.title} />
            </div>
            <TextField
              label="Заказчик"
              value={values.customerName}
              onValueChange={(v) => set('customerName', v)}
              error={errors.customerName}
            />
            <TextField label="Объект" value={values.objectName} onValueChange={(v) => set('objectName', v)} error={errors.objectName} />
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
          <dt>Код</dt>
          <dd className={form.mono}>{tender.code}</dd>
          <dt>Название</dt>
          <dd>{tender.title}</dd>
          <dt>Заказчик</dt>
          <dd>{tender.customerName ?? absent}</dd>
          <dt>Объект</dt>
          <dd>{tender.objectName ?? absent}</dd>
          <dt>Статус</dt>
          <dd>
            <StatusBadge status={tender.status} />
          </dd>
          <dt>Моя роль</dt>
          <dd>{tender.myRole ? MEMBER_ROLE_LABELS[tender.myRole] : 'Не участник'}</dd>
          <dt>Создан</dt>
          <dd className={form.num}>{formatDateTime(tender.createdAt)} МСК</dd>
          <dt>Изменён</dt>
          <dd className={form.num}>{formatDateTime(tender.updatedAt)} МСК</dd>
        </dl>
      )}

      {conflict ? (
        <ConflictDialog
          title="Тендер изменён другим пользователем"
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
