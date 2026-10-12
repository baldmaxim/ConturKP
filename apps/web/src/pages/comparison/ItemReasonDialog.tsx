import { useState, type FC } from 'react';
import { describeError, hasCode } from '../../api/errors';
import { setItemReason } from '../../api/sendEndpoints';
import type { IComparisonItem, TReasonKind, TReasonStatus } from '../../api/sendTypes';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { CHANGE, REASON_KIND, SUBJECT } from '../../utils/sendLabels';
import form from '../../styles/form.module.css';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ids = (text: string): string[] => [...new Set((text.match(UUID_RE) ?? []).map((x) => x.toLowerCase()))];

interface IItemReasonDialogProps {
  item: IComparisonItem;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Причина вывода сравнения (I11, A23): «не установлена» — по умолчанию и без оснований; «гипотеза» — с пояснением;
 * «подтверждена» — только с основанием (цитата или решение), которое автор может прочитать. Версии причины неизменны.
 */
export const ItemReasonDialog: FC<IItemReasonDialogProps> = ({ item, onClose, onSaved }) => {
  const [kind, setKind] = useState<TReasonKind>(item.reason?.reasonKind ?? 'document');
  const [status, setStatus] = useState<TReasonStatus>(item.reason?.reasonStatus === 'confirmed' ? 'confirmed' : 'hypothesis');
  const [rationale, setRationale] = useState('');
  const [fragments, setFragments] = useState('');
  const [decisions, setDecisions] = useState(typeof item.detail.decisionId === 'string' ? item.detail.decisionId : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unknown = kind === 'unknown';
  const bases = ids(fragments).length + ids(decisions).length;

  const save = (): void => {
    if (!unknown && status === 'confirmed' && bases === 0) {
      setError('Подтверждённая причина — только с основанием: укажите цитату или решение.');
      return;
    }
    setBusy(true);
    setError(null);
    setItemReason(item, {
      reasonKind: kind,
      reasonStatus: unknown ? 'unknown' : status,
      rationale: unknown ? null : rationale.trim() || null,
      fragmentIds: unknown ? [] : ids(fragments),
      decisionIds: unknown ? [] : ids(decisions),
    }).then(
      () => {
        setBusy(false);
        onSaved();
      },
      (e: unknown) => {
        setBusy(false);
        setError(hasCode(e, 'VERSION_CONFLICT') ? 'Причину изменил другой пользователь: закройте окно и откройте снова.' : describeError(e));
      },
    );
  };

  return (
    <Dialog
      title={`Причина: ${SUBJECT[item.subjectType] ?? item.subjectType} — ${(CHANGE[item.change]?.label ?? item.change).toLowerCase()}`}
      onClose={onClose}
      onSubmit={save}
      busy={busy}
      footer={
        <div className={form.actions}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy} autoFocus>
            Отмена
          </Button>
          <Button type="submit" variant="primary" icon="check" loading={busy} disabled={!unknown && rationale.trim() === ''}>
            Записать
          </Button>
        </div>
      }
    >
      <div className={form.stack}>
        <SelectField label="Вид причины" value={kind} onValueChange={(v) => setKind(v as TReasonKind)} options={Object.entries(REASON_KIND).map(([value, label]) => ({ value, label }))} />
        {!unknown ? (
          <>
            <SelectField
              label="Статус"
              value={status}
              onValueChange={(v) => setStatus(v as TReasonStatus)}
              options={[
                { value: 'hypothesis', label: 'Гипотеза — основание неполное' },
                { value: 'confirmed', label: 'Подтверждена — есть основание' },
              ]}
            />
            <TextAreaField label="Пояснение" value={rationale} onValueChange={setRationale} required rows={3} maxLength={4000} />
            <TextAreaField label="Цитаты-основания" value={fragments} onValueChange={setFragments} rows={2} hint="Идентификаторы фрагментов из поиска этапов сравниваемых выпусков." />
            <TextAreaField label="Решения-основания" value={decisions} onValueChange={setDecisions} rows={2} hint="Идентификаторы решений этого тендера." />
          </>
        ) : (
          <Notice tone="info">«Не установлена» — без оснований: причина останется неизвестной, пока её не укажет человек.</Notice>
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Dialog>
  );
};
