import { useState, type FC } from 'react';
import { createDestination, newDestinationVersion } from '../../api/deliveryEndpoints';
import type { IDestinationView, TDeliveryKind } from '../../api/deliveryTypes';
import { describeError, hasCode } from '../../api/errors';
import { Button } from '../../components/Button';
import { CheckboxGroup } from '../../components/CheckboxGroup';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { TextField } from '../../components/TextField';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../../hooks/unsavedChanges';

interface IDestinationDialogProps {
  // Новое назначение или новая версия путей существующего.
  current?: IDestinationView;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Назначение размещения (D-034): Яндекс Диск — папка внутри локальной папки синхронизации клиента Яндекс Диска и служебная
 * папка вне её на том же диске; сетевая папка — UNC-путь. Пути видит только администратор; доступ проверяет worker под
 * своей учётной записью («Проверить назначение»). Существующие доставки остаются на своей версии путей.
 */
export const DestinationDialog: FC<IDestinationDialogProps> = ({ current, onClose, onSaved }) => {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<TDeliveryKind>(current?.kind ?? 'smb');
  const [environment, setEnvironment] = useState<'test' | 'production'>('test');
  const [rootPath, setRootPath] = useState(current?.current.rootPath ?? '');
  // Служебная папка по умолчанию (<корень>/.kontur-staging) не переносится в новую версию: портал выведет её из нового корня.
  const defaultStaging = !!current && current.kind === 'smb' && /[\\/]\.kontur-staging$/u.test(current.current.stagingPath) && current.current.stagingPath.startsWith(current.current.rootPath);
  const [stagingPath, setStagingPath] = useState(current && !defaultStaging ? current.current.stagingPath : '');
  const [internal, setInternal] = useState(current?.current.includeInternal ?? false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idem = useIdempotencyKey();
  useUnsavedChanges(reason !== '' || (!current && (title !== '' || rootPath !== '')));
  const yandex = kind === 'yandex_disk';

  const submit = async (): Promise<void> => {
    const next: Record<string, string> = {};
    if (!current && !title.trim()) next.title = 'Укажите название.';
    if (!rootPath.trim()) next.rootPath = 'Укажите корень назначения.';
    if (yandex && !stagingPath.trim()) next.stagingPath = 'Для Яндекс Диска служебная папка обязательна.';
    if (reason.trim().length < 3) next.reason = 'Причина — не короче 3 символов.';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    const body = { rootPath: rootPath.trim(), stagingPath: stagingPath.trim() || null, includeInternal: internal, reason: reason.trim() };
    setSaving(true);
    try {
      if (current) await newDestinationVersion(current, body, idem.keyFor({ id: current.id, ...body }));
      else await createDestination({ ...body, title: title.trim(), kind, environment }, idem.keyFor({ title, kind, environment, ...body }));
      idem.reset();
      onSaved();
    } catch (e) {
      if (hasCode(e, 'IDEMPOTENCY_KEY_REUSED')) idem.reset();
      setFormError(describeError(e));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={current ? `Новая версия путей: ${current.title}` : 'Новое назначение размещения'}
      onClose={onClose}
      busy={saving}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" icon={current ? 'pencil' : 'plus'} loading={saving}>
            {current ? 'Сохранить версию' : 'Создать назначение'}
          </Button>
        </>
      }
    >
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      {current ? null : (
        <>
          <TextField label="Название" value={title} onValueChange={setTitle} required maxLength={200} error={errors.title} />
          <SelectField
            label="Тип"
            value={kind}
            onValueChange={(v) => setKind(v as TDeliveryKind)}
            options={[
              { value: 'smb', label: 'Сетевая папка' },
              { value: 'yandex_disk', label: 'Яндекс Диск (локальная папка синхронизации)' },
            ]}
          />
          <SelectField
            label="Среда"
            value={environment}
            onValueChange={(v) => setEnvironment(v as 'test' | 'production')}
            options={[
              { value: 'test', label: 'Тестовая — для тестовых выпусков' },
              { value: 'production', label: 'Боевая — для боевых выпусков' },
            ]}
            hint="Тип и среда потом не меняются."
          />
        </>
      )}
      <TextField
        label={yandex ? 'Папка внутри папки синхронизации Яндекс Диска' : 'Сетевая папка'}
        value={rootPath}
        onValueChange={setRootPath}
        required
        maxLength={400}
        placeholder={yandex ? 'D:\\Яндекс.Диск\\Контур КП' : '\\\\сервер\\ресурс\\Контур КП'}
        error={errors.rootPath}
        hint="Абсолютный путь: UNC (\\\\сервер\\ресурс\\…) или буква диска."
      />
      <TextField
        label="Служебная папка"
        value={stagingPath}
        onValueChange={setStagingPath}
        required={yandex}
        maxLength={400}
        placeholder={yandex ? 'D:\\kontur-staging' : 'по умолчанию — <корень>\\.kontur-staging'}
        error={errors.stagingPath}
        hint={yandex ? 'Вне папки синхронизации и на том же диске: незавершённые файлы не должны уходить в облако.' : 'Пусто — портал создаст .kontur-staging внутри корня.'}
      />
      <CheckboxGroup
        legend="Состав"
        options={[{ value: 'internal', label: 'Размещать и внутренние материалы с манифестами (иначе — только файлы для заказчика)' }]}
        selected={internal ? ['internal'] : []}
        onChange={(v) => setInternal(v.includes('internal'))}
      />
      <TextAreaField label="Причина" value={reason} onValueChange={setReason} required rows={2} maxLength={2000} error={errors.reason} />
    </Dialog>
  );
};
