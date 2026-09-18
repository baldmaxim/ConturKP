import { useState, type FC } from 'react';
import { resetUserPassword } from '../api/endpoints';
import { conflictCurrent, describeError, fieldErrorsOf, hasCode } from '../api/errors';
import { isUser } from '../api/guards';
import type { IUser } from '../api/types';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Notice } from '../components/Notice';
import { TextField } from '../components/TextField';
import { MIN_PASSWORD_LENGTH } from '../utils/constants';

interface IResetPasswordDialogProps {
  user: IUser;
  onClose: () => void;
  onDone: (user: IUser) => void;
  onReloaded: (user: IUser) => void;
}

export const ResetPasswordDialog: FC<IResetPasswordDialogProps> = ({ user, onClose, onDone, onReloaded }) => {
  const [base, setBase] = useState<IUser>(user);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflictCurrentUser, setConflictCurrentUser] = useState<IUser | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
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
    setSaving(true);
    try {
      const updated = await resetUserPassword(base.id, base.rowVersion, password);
      onDone(updated);
    } catch (error) {
      const current = conflictCurrent(error, isUser);
      if (hasCode(error, 'VERSION_CONFLICT')) {
        setConflictCurrentUser(current);
        setFormError(
          current
            ? 'Пользователь изменён другим администратором. Проверьте его данные («Перечитать») и повторите сброс.'
            : 'Пользователь изменён другим администратором. Закройте окно, обновите список и повторите.',
        );
      } else {
        setErrors(fieldErrorsOf(error));
        setFormError(describeError(error));
      }
      setSaving(false);
    }
  };

  const reread = (): void => {
    if (!conflictCurrentUser) {
      return;
    }
    setBase(conflictCurrentUser);
    onReloaded(conflictCurrentUser);
    setConflictCurrentUser(null);
    setFormError(null);
  };

  return (
    <Dialog
      title={`Сброс пароля: ${user.login}`}
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon="key-round" loading={saving} disabled={conflictCurrentUser !== null}>
            Заменить пароль
          </Button>
        </>
      }
    >
      {formError ? (
        <Notice
          tone={conflictCurrentUser ? 'warning' : 'danger'}
          action={
            conflictCurrentUser ? (
              <Button icon="refresh-cw" onClick={reread}>
                Перечитать
              </Button>
            ) : undefined
          }
        >
          {formError}
        </Notice>
      ) : null}
      <p>
        Пользователь: {base.displayName} ({base.login}). Новый пароль передайте ему лично.
      </p>
      <TextField
        label="Новый пароль"
        type="password"
        autoComplete="new-password"
        required
        value={password}
        onValueChange={setPassword}
        error={errors.password}
        hint={`Не короче ${MIN_PASSWORD_LENGTH} символов.`}
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
