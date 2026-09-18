import { useState, type FC } from 'react';
import { updateUser } from '../api/endpoints';
import { conflictCurrent, describeError, fieldErrorsOf, hasCode } from '../api/errors';
import { isUser } from '../api/guards';
import type { IUser, IUserPatch, TGlobalRole, TUserStatus } from '../api/types';
import { Button } from '../components/Button';
import { CheckboxGroup } from '../components/CheckboxGroup';
import { Dialog } from '../components/Dialog';
import { Notice } from '../components/Notice';
import { SelectField } from '../components/SelectField';
import { TextField } from '../components/TextField';
import { useUnsavedChanges } from '../hooks/unsavedChanges';
import { GLOBAL_ROLES, GLOBAL_ROLE_LABELS, globalRoleLabel } from '../utils/labels';
import form from '../styles/form.module.css';

const ROLE_OPTIONS = GLOBAL_ROLES.map((role) => ({ value: role, label: GLOBAL_ROLE_LABELS[role] }));
const STATUS_LABELS: Record<TUserStatus, string> = { active: 'Активен', disabled: 'Отключён' };

const toRoles = (values: string[]): TGlobalRole[] => GLOBAL_ROLES.filter((role) => values.includes(role));
const sameRoles = (a: string[], b: string[]): boolean => a.length === b.length && a.every((role) => b.includes(role));

interface IUserEditDialogProps {
  user: IUser;
  isSelf: boolean;
  onClose: () => void;
  onSaved: (user: IUser) => void;
  /** Пользователь перечитан после конфликта версий — обновить список. */
  onReloaded: (user: IUser) => void;
}

export const UserEditDialog: FC<IUserEditDialogProps> = ({ user, isSelf, onClose, onSaved, onReloaded }) => {
  const [base, setBase] = useState<IUser>(user);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [roles, setRoles] = useState<string[]>(user.roles);
  const [status, setStatus] = useState<TUserStatus>(user.status);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ current: IUser | null } | null>(null);
  const [saving, setSaving] = useState(false);

  const patch: IUserPatch = {};
  if (displayName.trim() !== base.displayName) {
    patch.displayName = displayName.trim();
  }
  if (!sameRoles(roles, base.roles)) {
    patch.roles = toRoles(roles);
  }
  if (status !== base.status) {
    patch.status = status;
  }
  const dirty = Object.keys(patch).length > 0;
  useUnsavedChanges(dirty);

  const submit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    if (!displayName.trim()) {
      nextErrors.displayName = 'Укажите имя.';
    }
    if (roles.length === 0) {
      nextErrors.roles = 'Выберите хотя бы одну роль.';
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const updated = await updateUser(base.id, base.rowVersion, patch);
      onSaved(updated);
    } catch (error) {
      if (hasCode(error, 'VERSION_CONFLICT')) {
        setConflict({ current: conflictCurrent(error, isUser) });
      } else {
        setErrors(fieldErrorsOf(error));
        setFormError(describeError(error));
      }
      setSaving(false);
    }
  };

  const reread = (current: IUser): void => {
    setBase(current);
    setDisplayName(current.displayName);
    setRoles(current.roles);
    setStatus(current.status);
    setConflict(null);
    onReloaded(current);
  };

  return (
    <Dialog
      title={`Пользователь ${user.login}`}
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" loading={saving} disabled={!dirty || conflict !== null}>
            Сохранить
          </Button>
        </>
      }
    >
      {conflict ? (
        <Notice
          tone="warning"
          action={
            conflict.current ? (
              <Button icon="refresh-cw" onClick={() => conflict.current && reread(conflict.current)}>
                Перечитать
              </Button>
            ) : undefined
          }
        >
          <p>Пользователь изменён другим администратором. Ваши изменения не сохранены.</p>
          {conflict.current ? (
            <dl className={form.details}>
              <dt>Имя сейчас</dt>
              <dd>{conflict.current.displayName}</dd>
              <dt>Роли сейчас</dt>
              <dd>{conflict.current.roles.map(globalRoleLabel).join(', ') || 'без ролей'}</dd>
              <dt>Статус сейчас</dt>
              <dd>{STATUS_LABELS[conflict.current.status]}</dd>
            </dl>
          ) : (
            <p>Закройте окно и откройте пользователя снова, чтобы увидеть текущие значения.</p>
          )}
        </Notice>
      ) : null}
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <TextField label="Логин" value={user.login} onValueChange={() => undefined} readOnly hint="Логин не меняется." />
      <TextField label="Имя для отображения" required value={displayName} onValueChange={setDisplayName} error={errors.displayName} />
      <CheckboxGroup legend="Роли" required options={ROLE_OPTIONS} selected={roles} onChange={setRoles} error={errors.roles} />
      <SelectField
        label="Статус"
        value={status}
        options={[
          { value: 'active', label: STATUS_LABELS.active },
          { value: 'disabled', label: STATUS_LABELS.disabled },
        ]}
        onValueChange={(value) => setStatus(value === 'disabled' ? 'disabled' : 'active')}
        hint="Отключённый пользователь не может войти в портал."
      />
      {isSelf && (status === 'disabled' || !roles.includes('admin')) ? (
        <Notice tone="warning">Это ваша учётная запись: после сохранения вы можете потерять доступ к администрированию.</Notice>
      ) : null}
    </Dialog>
  );
};
