import { useState, type FC } from 'react';
import { createTender } from '../api/endpoints';
import { describeError, fieldErrorsOf, hasCode } from '../api/errors';
import type { ITender, ITenderCreateInput } from '../api/types';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Notice } from '../components/Notice';
import { TextField } from '../components/TextField';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../hooks/unsavedChanges';

interface ICreateTenderDialogProps {
  onClose: () => void;
  onCreated: (tender: ITender) => void;
}

export const CreateTenderDialog: FC<ICreateTenderDialogProps> = ({ onClose, onCreated }) => {
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [objectName, setObjectName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotency = useIdempotencyKey();

  useUnsavedChanges(code !== '' || title !== '' || customerName !== '' || objectName !== '');

  const submit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    if (!code.trim()) {
      nextErrors.code = 'Укажите код тендера.';
    }
    if (!title.trim()) {
      nextErrors.title = 'Укажите название.';
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    const input: ITenderCreateInput = { code: code.trim(), title: title.trim() };
    if (customerName.trim()) {
      input.customerName = customerName.trim();
    }
    if (objectName.trim()) {
      input.objectName = objectName.trim();
    }
    setSaving(true);
    try {
      const tender = await createTender(input, idempotency.keyFor(input));
      idempotency.reset();
      onCreated(tender);
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
      title="Новый тендер"
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon="plus" loading={saving}>
            Создать тендер
          </Button>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <TextField
        label="Код"
        required
        autoComplete="off"
        value={code}
        onValueChange={setCode}
        error={errors.code}
        hint="Уникальный код тендера, например КП-2026-014."
      />
      <TextField label="Название" required autoComplete="off" value={title} onValueChange={setTitle} error={errors.title} />
      <TextField
        label="Заказчик"
        autoComplete="organization"
        value={customerName}
        onValueChange={setCustomerName}
        error={errors.customerName}
      />
      <TextField label="Объект" autoComplete="off" value={objectName} onValueChange={setObjectName} error={errors.objectName} />
    </Dialog>
  );
};
