import { useState, type FC } from 'react';
import { describeError, fieldErrorsOf, hasCode } from '../../api/errors';
import { createMailbox } from '../../api/mailEndpoints';
import type { IMailbox } from '../../api/mailTypes';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../../hooks/unsavedChanges';

interface ICreateMailboxDialogProps {
  onClose: () => void;
  onCreated: (mailbox: IMailbox) => void;
}

/** Регистрация ящика (OD-07-2): явная, по адресу; сканирования всех ящиков нет. Доступ выдаётся отдельно. */
export const CreateMailboxDialog: FC<ICreateMailboxDialogProps> = ({ onClose, onCreated }) => {
  const [system, setSystem] = useState<'manual' | 'mailhub'>('manual');
  const [account, setAccount] = useState('');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotency = useIdempotencyKey();

  useUnsavedChanges(account !== '' || name !== '');

  const submit = async (): Promise<void> => {
    const next: Record<string, string> = {};
    if (!account.trim()) next.externalAccountId = 'Укажите адрес ящика.';
    if (!name.trim()) next.displayName = 'Укажите название.';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    const input = { system, externalAccountId: account.trim(), displayName: name.trim() };
    setSaving(true);
    try {
      const mailbox = await createMailbox(input, idempotency.keyFor(input));
      idempotency.reset();
      onCreated(mailbox);
    } catch (error) {
      if (hasCode(error, 'IDEMPOTENCY_KEY_REUSED')) idempotency.reset();
      setErrors(fieldErrorsOf(error));
      setFormError(hasCode(error, 'STATE_CONFLICT') ? 'Такой ящик уже зарегистрирован.' : describeError(error));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Новый почтовый ящик"
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon="plus" loading={saving}>
            Зарегистрировать
          </Button>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <SelectField
        label="Источник"
        value={system}
        options={[
          { value: 'manual', label: 'Ручной импорт EML' },
          { value: 'mailhub', label: 'Ящик MailHub' },
        ]}
        onValueChange={(v) => setSystem(v as 'manual' | 'mailhub')}
        hint="Автоматическое чтение MailHub пока заблокировано (X-03): письма и в этот ящик загружаются файлами EML."
      />
      <TextField label="Адрес ящика" required type="email" autoComplete="off" value={account} onValueChange={setAccount} error={errors.externalAccountId} />
      <TextField label="Название" required autoComplete="off" value={name} onValueChange={setName} error={errors.displayName} hint="Например: Тендерный отдел." />
      <Notice tone="info">Администратор ящиков ведёт ящики и выдачи, но письма читает только с собственной выдачей «Чтение писем».</Notice>
    </Dialog>
  );
};
