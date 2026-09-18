import { useState, type FC } from 'react';
import { createUser } from '../api/endpoints';
import { describeError, fieldErrorsOf, hasCode } from '../api/errors';
import type { IUser, IUserCreateInput, TGlobalRole } from '../api/types';
import { Button } from '../components/Button';
import { CheckboxGroup } from '../components/CheckboxGroup';
import { Dialog } from '../components/Dialog';
import { Notice } from '../components/Notice';
import { TextField } from '../components/TextField';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../hooks/unsavedChanges';
import { GLOBAL_ROLES, GLOBAL_ROLE_LABELS } from '../utils/labels';
import { MIN_PASSWORD_LENGTH } from '../utils/constants';

const ROLE_OPTIONS = GLOBAL_ROLES.map((role) => ({ value: role, label: GLOBAL_ROLE_LABELS[role] }));

const toRoles = (values: string[]): TGlobalRole[] =>
  GLOBAL_ROLES.filter((role) => values.includes(role));

interface IUserCreateDialogProps {
  onClose: () => void;
  onCreated: (user: IUser) => void;
}

export const UserCreateDialog: FC<IUserCreateDialogProps> = ({ onClose, onCreated }) => {
  const [login, setLogin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roles, setRoles] = useState<string[]>(['engineer']);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotency = useIdempotencyKey();

  useUnsavedChanges(login !== '' || displayName !== '' || password !== '');

  const submit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    if (!login.trim()) {
      nextErrors.login = 'Укажите логин.';
    }
    if (!displayName.trim()) {
      nextErrors.displayName = 'Укажите имя.';
    }
    if (roles.length === 0) {
      nextErrors.roles = 'Выберите хотя бы одну роль.';
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      nextErrors.password = `Не короче ${MIN_PASSWORD_LENGTH} символов.`;
    }
    if (repeat !== password) {
      nextErrors.repeat = 'Пароли не совпадают.';
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    const input: IUserCreateInput = {
      login: login.trim(),
      displayName: displayName.trim(),
      roles: toRoles(roles),
      password,
    };
    setSaving(true);
    try {
      const user = await createUser(input, idempotency.keyFor(input));
      idempotency.reset();
      onCreated(user);
    } catch (error) {
      if (hasCode(error, 'IDEMPOTENCY_KEY_REUSED')) {
        idempotency.reset();
      }
      setErrors(fieldErrorsOf(error));
      setFormError(describeError(error));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Новый пользователь"
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon="user-plus" loading={saving}>
            Создать пользователя
          </Button>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <TextField
        label="Логин"
        required
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={login}
        onValueChange={setLogin}
        error={errors.login}
      />
      <TextField label="Имя для отображения" required autoComplete="off" value={displayName} onValueChange={setDisplayName} error={errors.displayName} />
      <CheckboxGroup legend="Роли" required options={ROLE_OPTIONS} selected={roles} onChange={setRoles} error={errors.roles} />
      <TextField
        label="Начальный пароль"
        type="password"
        autoComplete="new-password"
        required
        value={password}
        onValueChange={setPassword}
        error={errors.password}
        hint={`Не короче ${MIN_PASSWORD_LENGTH} символов. Передайте его пользователю лично; сменить можно в меню «Сменить пароль».`}
      />
      <TextField
        label="Пароль ещё раз"
        type="password"
        autoComplete="new-password"
        required
        value={repeat}
        onValueChange={setRepeat}
        error={errors.repeat}
      />
    </Dialog>
  );
};
