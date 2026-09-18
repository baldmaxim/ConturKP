import type { FC, ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import type { TIconName } from './Icon';

interface IConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmIcon?: TIconName;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Подтверждение действия: начальный фокус на «Отмена», Esc закрывает. */
export const ConfirmDialog: FC<IConfirmDialogProps> = ({
  title,
  children,
  confirmLabel,
  confirmIcon,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}) => (
  <Dialog
    title={title}
    onClose={onClose}
    busy={busy}
    footer={
      <>
        <Button variant="ghost" onClick={onClose} disabled={busy} autoFocus>
          Отмена
        </Button>
        <Button variant={danger ? 'dangerFilled' : 'primary'} icon={confirmIcon} loading={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </>
    }
  >
    {children}
  </Dialog>
);
