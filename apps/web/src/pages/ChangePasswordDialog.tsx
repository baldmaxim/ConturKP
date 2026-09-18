import { useState, type FC } from 'react';
import { changeMyPassword } from '../api/endpoints';
import { describeError, fieldErrorsOf, hasCode } from '../api/errors';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Notice } from '../components/Notice';
import { TextField } from '../components/TextField';
import { useToast } from '../hooks/useToast';
import { useUnsavedChanges } from '../hooks/unsavedChanges';
import { MIN_PASSWORD_LENGTH } from '../utils/constants';

interface IChangePasswordDialogProps {
  onClose: () => void;
}

export const ChangePasswordDialog: FC<IChangePasswordDialogProps> = ({ onClose }) => {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useUnsavedChanges(currentPassword !== '' || newPassword !== '' || repeat !== '');

  const submit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    if (!currentPassword) {
      nextErrors.currentPassword = 'Введите текущий пароль.';
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      nextErrors.newPassword = `Не короче ${MIN_PASSWORD_LENGTH} символов.`;
    }
    if (repeat !== newPassword) {
      nextErrors.repeat = 'Пароли не совпадают.';
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    setSaving(true);
    try {
      await changeMyPassword(currentPassword, newPassword);
      toast.push({ kind: 'success', text: 'Пароль изменён. Остальные сеансы завершены.' });
      onClose();
    } catch (error) {
      if (hasCode(error, 'VALIDATION_FAILED')) {
        setErrors(fieldErrorsOf(error));
      }
      setFormError(describeError(error));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Смена пароля"
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon="key-round" loading={saving}>
            Сменить пароль
          </Button>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <TextField
        label="Текущий пароль"
        type="password"
        autoComplete="current-password"
        required
        value={currentPassword}
        onValueChange={setCurrentPassword}
        error={errors.currentPassword}
      />
      <TextField
        label="Новый пароль"
        type="password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        value={newPassword}
        onValueChange={setNewPassword}
        error={errors.newPassword}
        hint={`Не короче ${MIN_PASSWORD_LENGTH} символов. После смены другие сеансы будут завершены.`}
      />
      <TextField
        label="Новый пароль ещё раз"
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
