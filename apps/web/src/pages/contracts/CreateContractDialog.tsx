import { useState, type FC } from 'react';
import { createContract } from '../../api/contractEndpoints';
import type { IContract, IContractCreateInput } from '../../api/contractTypes';
import { describeError, fieldErrorsOf, hasCode } from '../../api/errors';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { TextField } from '../../components/TextField';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../../hooks/unsavedChanges';

interface ICreateContractDialogProps {
  onClose: () => void;
  onCreated: (contract: IContract) => void;
}

/** Новый договор: создатель сразу получает чтение и ведение (D-022 OD-2), связь с тендером — отдельным правом. */
export const CreateContractDialog: FC<ICreateContractDialogProps> = ({ onClose, onCreated }) => {
  const [number, setNumber] = useState('');
  const [title, setTitle] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [signedOn, setSignedOn] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotency = useIdempotencyKey();

  useUnsavedChanges(number !== '' || title !== '' || counterparty !== '' || signedOn !== '');

  const submit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    if (!number.trim()) nextErrors.number = 'Укажите номер договора.';
    if (!title.trim()) nextErrors.title = 'Укажите предмет договора.';
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) return;
    const input: IContractCreateInput = { number: number.trim(), title: title.trim() };
    if (counterparty.trim()) input.counterparty = counterparty.trim();
    if (signedOn) input.signedOn = signedOn;
    setSaving(true);
    try {
      const contract = await createContract(input, idempotency.keyFor(input));
      idempotency.reset();
      onCreated(contract);
    } catch (error) {
      if (hasCode(error, 'IDEMPOTENCY_KEY_REUSED')) idempotency.reset();
      setErrors(fieldErrorsOf(error));
      setFormError(describeError(error));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Новый договор"
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon="plus" loading={saving}>
            Создать договор
          </Button>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <TextField label="Номер" required autoComplete="off" value={number} onValueChange={setNumber} error={errors.number} hint="Например: 12/2026-П." />
      <TextField label="Предмет" required autoComplete="off" value={title} onValueChange={setTitle} error={errors.title} />
      <TextField label="Контрагент" autoComplete="organization" value={counterparty} onValueChange={setCounterparty} error={errors.counterparty} />
      <TextField label="Дата подписания" type="date" value={signedOn} onValueChange={setSignedOn} error={errors.signedOn} />
      <Notice tone="info">
        Вы получите чтение и ведение этого договора. Связь с тендером подтверждает пользователь с правом «Связь с тендерами» — его выдаёт
        администратор договоров.
      </Notice>
    </Dialog>
  );
};
