import { useState, type FC } from 'react';
import { describeError, hasCode } from '../../api/errors';
import { updateIntakeChannel } from '../../api/sourceEndpoints';
import type { IIntakeChannel } from '../../api/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { TextAreaField } from '../../components/TextAreaField';
import { useUnsavedChanges } from '../../hooks/unsavedChanges';
import form from '../../styles/form.module.css';

const MIN_REASON = 5;

interface IDisableChannelDialogProps {
  channel: IIntakeChannel;
  onClose: () => void;
  onDisabled: (channel: IIntakeChannel) => void;
  /** 412: канал изменён — список перечитывается. */
  onStale: (message: string) => void;
}

/** Отключение наблюдаемой папки руководителем тендера (hold.resolve): только с причиной. */
export const DisableChannelDialog: FC<IDisableChannelDialogProps> = ({ channel, onClose, onDisabled, onStale }) => {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useUnsavedChanges(reason.trim() !== '');

  const submit = async (): Promise<void> => {
    if (reason.trim().length < MIN_REASON) {
      setError(`Опишите причину: не меньше ${MIN_REASON} символов.`);
      return;
    }
    setError(undefined);
    setFormError(null);
    setSaving(true);
    try {
      onDisabled(await updateIntakeChannel(channel.id, channel.rowVersion, { active: false, disabledReason: reason.trim() }));
    } catch (err) {
      setSaving(false);
      if (hasCode(err, 'VERSION_CONFLICT')) {
        onStale('Канал изменён другим пользователем. Список перечитан — проверьте состояние и повторите.');
        return;
      }
      setFormError(describeError(err));
    }
  };

  return (
    <Dialog
      title="Отключить наблюдаемую папку?"
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving} autoFocus>
            Отмена
          </Button>
          <Button variant="dangerFilled" type="submit" icon="power-off" loading={saving}>
            Отключить папку
          </Button>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <p className={form.mono}>{channel.locator}</p>
      <p>Сканирование прекратится. Включить папку снова может только администратор портала.</p>
      <TextAreaField label="Причина отключения" required value={reason} onValueChange={setReason} error={error} maxLength={2000} />
    </Dialog>
  );
};
