import { useState, type FC, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import type { TIconName } from '../../components/Icon';
import { TextAreaField } from '../../components/TextAreaField';

interface IReasonDialogProps {
  title: string;
  children?: ReactNode;
  label: string;
  confirmLabel: string;
  confirmIcon?: TIconName;
  minLength?: number;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

/** Действие с обязательной причиной (возврат, отзыв, принятие риска, решение по событию): начальный фокус — «Отмена». */
export const ReasonDialog: FC<IReasonDialogProps> = ({ title, children, label, confirmLabel, confirmIcon, minLength = 1, busy, onConfirm, onClose }) => {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const short = reason.trim().length < minLength;
  const submit = (): void => {
    setTouched(true);
    if (!short) onConfirm(reason.trim());
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy} autoFocus>
            Отмена
          </Button>
          <Button type="submit" variant="primary" icon={confirmIcon} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      <TextAreaField
        label={label}
        value={reason}
        onValueChange={setReason}
        onClear={() => setReason('')}
        required
        rows={3}
        maxLength={2000}
        error={touched && short ? (minLength > 1 ? `Причина — не короче ${minLength} символов` : 'Укажите причину') : undefined}
      />
    </Dialog>
  );
};
