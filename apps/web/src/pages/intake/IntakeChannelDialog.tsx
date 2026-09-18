import { useState, type FC } from 'react';
import { ApiError } from '../../api/client';
import { conflictCurrent, describeError, fieldErrorsOf, hasCode } from '../../api/errors';
import { isIntakeChannel } from '../../api/guards';
import { createIntakeChannel, updateIntakeChannel } from '../../api/sourceEndpoints';
import type { IIntakeChannel, IIntakeChannelCreateInput, IIntakeChannelPatch, TChannelOrigin } from '../../api/types';
import { Button } from '../../components/Button';
import { ConflictDialog, type IConflictRow } from '../../components/ConflictDialog';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { TextField } from '../../components/TextField';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../../hooks/unsavedChanges';
import { CHANNEL_ORIGIN_LABELS, channelOriginLabel } from '../../utils/sourceLabels';
import fieldStyles from '../../components/Field.module.css';

const ORIGINS = Object.keys(CHANNEL_ORIGIN_LABELS) as TChannelOrigin[];
const ORIGIN_OPTIONS = ORIGINS.map((value) => ({ value, label: CHANNEL_ORIGIN_LABELS[value] }));
const FRESHNESS = { min: 60, max: 7 * 86400, def: 900 };
const INTERVAL = { min: 5, max: 86400, def: 60 };
const MIN_REASON = 5;

interface IChannelForm {
  origin: TChannelOrigin;
  locator: string;
  freshness: string;
  interval: string;
  active: boolean;
  disabledReason: string;
}

const toForm = (channel: IIntakeChannel | null): IChannelForm => ({
  origin: channel?.origin ?? 'local',
  locator: channel?.locator ?? '',
  freshness: String(channel?.freshnessSeconds ?? FRESHNESS.def),
  interval: String(channel?.scanIntervalSeconds ?? INTERVAL.def),
  active: channel?.active ?? true,
  disabledReason: channel?.disabledReason ?? '',
});

/** Ошибка сервера с его пояснением (например, «папка вне разрешённых корней»). */
const describeWithDetail = (error: unknown): string => {
  if (error instanceof ApiError && error.code === 'VALIDATION_FAILED' && error.problem?.detail) {
    return `Сервер отклонил данные: ${error.problem.detail}.`;
  }
  return describeError(error);
};

const parseRange = (value: string, range: { min: number; max: number }): number | null => {
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= range.min && n <= range.max ? n : null;
};

interface IIntakeChannelDialogProps {
  tenderId: string;
  /** null — создание нового канала. */
  channel: IIntakeChannel | null;
  onClose: () => void;
  onSaved: (channel: IIntakeChannel) => void;
  onReload: () => void;
}

/** Создание и настройка наблюдаемой папки (только администратор, admin.intake). */
export const IntakeChannelDialog: FC<IIntakeChannelDialogProps> = ({ tenderId, channel, onClose, onSaved, onReload }) => {
  const [values, setValues] = useState<IChannelForm>(() => toForm(channel));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ current: IIntakeChannel | null } | null>(null);
  const idempotency = useIdempotencyKey();
  const initial = toForm(channel);
  useUnsavedChanges(JSON.stringify(values) !== JSON.stringify(initial));

  const set = <K extends keyof IChannelForm>(key: K, value: IChannelForm[K]): void =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const submit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    const freshness = parseRange(values.freshness, FRESHNESS);
    const interval = parseRange(values.interval, INTERVAL);
    if (!values.locator.trim()) {
      nextErrors.locator = 'Укажите абсолютный путь к папке.';
    }
    if (freshness === null) {
      nextErrors.freshnessSeconds = `Целое число от ${FRESHNESS.min} до ${FRESHNESS.max}.`;
    }
    if (interval === null) {
      nextErrors.scanIntervalSeconds = `Целое число от ${INTERVAL.min} до ${INTERVAL.max}.`;
    }
    const disabling = channel !== null && !values.active && (channel.active || values.disabledReason.trim() !== (channel.disabledReason ?? ''));
    if (disabling && values.disabledReason.trim().length < MIN_REASON) {
      nextErrors.disabledReason = `Причина отключения — не меньше ${MIN_REASON} символов.`;
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0 || freshness === null || interval === null) {
      return;
    }
    setSaving(true);
    try {
      if (!channel) {
        const input: IIntakeChannelCreateInput = {
          origin: values.origin,
          locator: values.locator.trim(),
          freshnessSeconds: freshness,
          scanIntervalSeconds: interval,
        };
        const created = await createIntakeChannel(tenderId, input, idempotency.keyFor(input));
        idempotency.reset();
        onSaved(created);
        return;
      }
      const patch: IIntakeChannelPatch = {};
      if (values.origin !== channel.origin) patch.origin = values.origin;
      if (values.locator.trim() !== channel.locator) patch.locator = values.locator.trim();
      if (freshness !== channel.freshnessSeconds) patch.freshnessSeconds = freshness;
      if (interval !== channel.scanIntervalSeconds) patch.scanIntervalSeconds = interval;
      if (values.active !== channel.active) patch.active = values.active;
      if (disabling) patch.disabledReason = values.disabledReason.trim();
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      onSaved(await updateIntakeChannel(channel.id, channel.rowVersion, patch));
    } catch (error) {
      setSaving(false);
      if (hasCode(error, 'VERSION_CONFLICT')) {
        setConflict({ current: conflictCurrent(error, isIntakeChannel) });
        return;
      }
      if (hasCode(error, 'IDEMPOTENCY_KEY_REUSED')) {
        idempotency.reset();
      }
      setErrors(fieldErrorsOf(error));
      setFormError(describeWithDetail(error));
    }
  };

  const conflictRows: IConflictRow[] = conflict?.current
    ? [
        { label: 'Источник', mine: channelOriginLabel(values.origin), current: channelOriginLabel(conflict.current.origin) },
        { label: 'Папка', mine: values.locator.trim(), current: conflict.current.locator },
        { label: 'Окно свежести, с', mine: values.freshness, current: String(conflict.current.freshnessSeconds) },
        { label: 'Интервал скана, с', mine: values.interval, current: String(conflict.current.scanIntervalSeconds) },
        { label: 'Состояние', mine: values.active ? 'включён' : 'отключён', current: conflict.current.active ? 'включён' : 'отключён' },
      ]
    : [];

  if (conflict) {
    return (
      <ConflictDialog
        title="Канал изменён другим пользователем"
        rows={conflictRows}
        currentUnknown={!conflict.current}
        onReload={() => {
          setConflict(null);
          onReload();
        }}
        onClose={() => setConflict(null)}
      />
    );
  }

  return (
    <Dialog
      title={channel ? 'Настройка наблюдаемой папки' : 'Новая наблюдаемая папка'}
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon={channel ? undefined : 'plus'} loading={saving}>
            {channel ? 'Сохранить' : 'Добавить папку'}
          </Button>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <SelectField
        label="Источник"
        value={values.origin}
        options={ORIGIN_OPTIONS}
        onValueChange={(v) => set('origin', ORIGINS.find((o) => o === v) ?? values.origin)}
        error={errors.origin}
      />
      <TextField
        label="Папка на сервере"
        required
        value={values.locator}
        onValueChange={(v) => set('locator', v)}
        error={errors.locator}
        autoComplete="off"
        spellCheck={false}
        hint="Абсолютный путь внутри разрешённых корней сервера (INTAKE_ROOTS). Яндекс Диск и сетевая папка — через их локальную синхронизацию или подключение."
      />
      <TextField
        label="Окно свежести, с"
        inputMode="numeric"
        value={values.freshness}
        onValueChange={(v) => set('freshness', v)}
        error={errors.freshnessSeconds}
        hint={`Канал актуален, если последний успешный скан не старше окна. ${FRESHNESS.min}–${FRESHNESS.max}, обычно ${FRESHNESS.def}.`}
      />
      <TextField
        label="Интервал скана, с"
        inputMode="numeric"
        value={values.interval}
        onValueChange={(v) => set('interval', v)}
        error={errors.scanIntervalSeconds}
        hint={`${INTERVAL.min}–${INTERVAL.max}, обычно ${INTERVAL.def}.`}
      />
      {channel ? (
        <>
          <label className={fieldStyles.option}>
            <input type="checkbox" checked={values.active} onChange={(event) => set('active', event.target.checked)} />
            <span>Канал включён</span>
          </label>
          {!values.active ? (
            <TextAreaField
              label="Причина отключения"
              required
              value={values.disabledReason}
              onValueChange={(v) => set('disabledReason', v)}
              error={errors.disabledReason}
              maxLength={2000}
            />
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
};
