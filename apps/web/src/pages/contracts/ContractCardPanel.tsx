import { useState, type FC } from 'react';
import { getContract, setContractArchived, updateContract } from '../../api/contractEndpoints';
import type { IContract, IContractPatch } from '../../api/contractTypes';
import { describeError, fieldErrorsOf, hasCode } from '../../api/errors';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Notice } from '../../components/Notice';
import { StatusBadge } from '../../components/StatusBadge';
import { TextField } from '../../components/TextField';
import { useToast } from '../../hooks/useToast';
import { useUnsavedChanges } from '../../hooks/unsavedChanges';
import { CONTRACT_CAPABILITY_LABELS } from '../../utils/contractLabels';
import { formatDateOnly, formatDateTime } from '../../utils/datetime';
import form from '../../styles/form.module.css';

interface IContractCardPanelProps {
  contract: IContract;
  onChanged: (contract: IContract) => void;
}

interface IForm {
  number: string;
  title: string;
  counterparty: string;
  signedOn: string;
}

const toForm = (c: IContract): IForm => ({ number: c.number, title: c.title, counterparty: c.counterparty ?? '', signedOn: c.signedOn ?? '' });

// Контрагент и дата — содержательные поля: меняет их только тот, кто их видит (contract.read).
const buildPatch = (c: IContract, v: IForm): IContractPatch => {
  const patch: IContractPatch = {};
  if (v.number.trim() !== c.number) patch.number = v.number.trim();
  if (v.title.trim() !== c.title) patch.title = v.title.trim();
  if (!c.restricted) {
    const counterparty = v.counterparty.trim() || null;
    if (counterparty !== c.counterparty) patch.counterparty = counterparty;
    const signedOn = v.signedOn || null;
    if (signedOn !== c.signedOn) patch.signedOn = signedOn;
  }
  return patch;
};

/** Карточка договора: без contract.read — только административные метаданные (D-022 OD-2). Архив — без удаления (OD-5). */
export const ContractCardPanel: FC<IContractCardPanelProps> = ({ contract, onChanged }) => {
  const toast = useToast();
  const canManage = contract.capabilities.includes('contract.manage');
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<IForm>(() => toForm(contract));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const dirty = editing && Object.keys(buildPatch(contract, values)).length > 0;
  useUnsavedChanges(dirty);

  const set = <K extends keyof IForm>(key: K, value: IForm[K]): void => setValues((prev) => ({ ...prev, [key]: value }));

  const reloadAfterConflict = async (): Promise<void> => {
    toast.push({ kind: 'error', text: 'Карточку изменил другой пользователь — показана текущая версия.' });
    onChanged(await getContract(contract.id));
    setEditing(false);
  };

  const save = async (): Promise<void> => {
    if (!values.number.trim() || !values.title.trim()) {
      setErrors({ ...(values.number.trim() ? {} : { number: 'Укажите номер.' }), ...(values.title.trim() ? {} : { title: 'Укажите предмет.' }) });
      return;
    }
    const patch = buildPatch(contract, values);
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      onChanged(await updateContract(contract.id, contract.rowVersion, patch));
      setEditing(false);
      toast.push({ kind: 'success', text: 'Карточка договора сохранена.' });
    } catch (error) {
      if (hasCode(error, 'VERSION_CONFLICT')) await reloadAfterConflict();
      else {
        setErrors(fieldErrorsOf(error));
        setFormError(describeError(error));
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async (): Promise<void> => {
    setSaving(true);
    try {
      const next = await setContractArchived(contract.id, contract.rowVersion, contract.status === 'active');
      onChanged(next);
      toast.push({ kind: 'success', text: next.status === 'archived' ? 'Договор перенесён в архив.' : 'Договор возвращён из архива.' });
    } catch (error) {
      if (hasCode(error, 'VERSION_CONFLICT')) await reloadAfterConflict();
      else toast.push({ kind: 'error', text: describeError(error) });
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  if (editing) {
    return (
      <form
        className={form.stack}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {formError ? <Notice tone="danger">{formError}</Notice> : null}
        <TextField label="Номер" required value={values.number} onValueChange={(v) => set('number', v)} error={errors.number} maxLength={100} />
        <TextField label="Предмет" required value={values.title} onValueChange={(v) => set('title', v)} error={errors.title} maxLength={500} />
        {contract.restricted ? (
          <Notice tone="info" icon="lock">
            Контрагент и дата подписания видны и меняются только с правом чтения договора.
          </Notice>
        ) : (
          <>
            <TextField label="Контрагент" value={values.counterparty} onValueChange={(v) => set('counterparty', v)} error={errors.counterparty} maxLength={500} />
            <TextField label="Дата подписания" type="date" value={values.signedOn} onValueChange={(v) => set('signedOn', v)} error={errors.signedOn} />
          </>
        )}
        <div className={form.actions}>
          <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" loading={saving} disabled={!dirty}>
            Сохранить
          </Button>
        </div>
      </form>
    );
  }

  const absent = <span className={form.absent}>не указан</span>;
  return (
    <section className={form.stack} aria-label="Карточка договора">
      <dl className={form.details}>
        <dt>Номер</dt>
        <dd className={form.mono}>{contract.number}</dd>
        <dt>Предмет</dt>
        <dd>{contract.title}</dd>
        <dt>Контрагент</dt>
        <dd>{contract.restricted ? <span className={form.absent}>скрыто: нет права чтения</span> : (contract.counterparty ?? absent)}</dd>
        <dt>Дата подписания</dt>
        <dd className={form.num}>{contract.restricted ? <span className={form.absent}>скрыто</span> : contract.signedOn ? formatDateOnly(contract.signedOn) : absent}</dd>
        <dt>Статус</dt>
        <dd>
          <StatusBadge status={contract.status} />
        </dd>
        <dt>Создал</dt>
        <dd>{`${contract.createdBy.displayName}, ${formatDateTime(contract.createdAt)} МСК`}</dd>
        <dt>Мои права</dt>
        <dd>{contract.capabilities.length > 0 ? contract.capabilities.map((c) => CONTRACT_CAPABILITY_LABELS[c]).join(' · ') : 'нет — вы администратор договоров'}</dd>
      </dl>
      {canManage ? (
        <div className={form.actions}>
          <Button
            icon="pencil"
            onClick={() => {
              setValues(toForm(contract));
              setEditing(true);
            }}
          >
            Изменить карточку
          </Button>
          <Button icon="archive" onClick={() => setConfirming(true)}>
            {contract.status === 'active' ? 'В архив' : 'Вернуть из архива'}
          </Button>
        </div>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={contract.status === 'active' ? 'Перенести договор в архив' : 'Вернуть договор из архива'}
          confirmLabel={contract.status === 'active' ? 'В архив' : 'Вернуть'}
          confirmIcon="archive"
          busy={saving}
          onConfirm={() => void toggleArchive()}
          onClose={() => setConfirming(false)}
        >
          <p>
            {contract.status === 'active'
              ? 'Документы, редакции, распознавание и снимки этапов сохранятся — физического удаления нет. Новые документы и связи в архиве не добавляются.'
              : 'Договор снова примет новые документы и связи с тендерами.'}
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
};
