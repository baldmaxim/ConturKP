import { useState, type FC } from 'react';
import { createStage } from '../api/endpoints';
import { describeError, fieldErrorsOf, hasCode } from '../api/errors';
import type { IStage, IStageCreateInput } from '../api/types';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Notice } from '../components/Notice';
import { TextField } from '../components/TextField';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../hooks/unsavedChanges';
import { moscowInputToIso } from '../utils/datetime';

interface ICreateStageDialogProps {
  tenderId: string;
  onClose: () => void;
  onCreated: (stage: IStage) => void;
}

export const CreateStageDialog: FC<ICreateStageDialogProps> = ({ tenderId, onClose, onCreated }) => {
  const [title, setTitle] = useState('');
  const [deadline, setDeadline] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotency = useIdempotencyKey();

  useUnsavedChanges(title !== '' || deadline !== '');

  const submit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    if (!title.trim()) {
      nextErrors.title = 'Укажите название этапа.';
    }
    const deadlineIso = deadline ? moscowInputToIso(deadline) : null;
    if (deadline && !deadlineIso) {
      nextErrors.submissionDeadline = 'Укажите дату и время полностью.';
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    const input: IStageCreateInput = { title: title.trim(), submissionDeadline: deadlineIso };
    setSaving(true);
    try {
      const stage = await createStage(tenderId, input, idempotency.keyFor(input));
      idempotency.reset();
      onCreated(stage);
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
      title="Новый этап"
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon="plus" loading={saving}>
            Создать этап
          </Button>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <TextField label="Название" required autoComplete="off" value={title} onValueChange={setTitle} error={errors.title} />
      <TextField
        label="Срок подачи, МСК"
        type="datetime-local"
        value={deadline}
        onValueChange={setDeadline}
        error={errors.submissionDeadline}
        hint="Время по Москве. Можно оставить пустым и указать позже."
      />
    </Dialog>
  );
};
