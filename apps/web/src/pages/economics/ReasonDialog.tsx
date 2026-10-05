import { useState, type FC } from 'react';
import { setExplanation } from '../../api/economicsEndpoints';
import type { IComparisonUnit, IExplanation } from '../../api/economicsTypes';
import { describeError, hasCode } from '../../api/errors';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { REASON_KIND_LABEL } from '../../utils/economicsLabels';
import form from '../../styles/form.module.css';

interface IReasonDialogProps {
  unit: IComparisonUnit;
  onClose: () => void;
  onSaved: () => void;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * Причина изменения единицы (I11, A23): «подтверждена» — только с основанием своего вида (цитата документа, ответа
 * заказчика или предложения поставщика; внутреннее решение — с обоснованием); «предполагаемая» — без полного основания;
 * «не установлена» — без оснований. Версия причины — с автором; прежние версии остаются в истории.
 */
export const ReasonDialog: FC<IReasonDialogProps> = ({ unit, onClose, onSaved }) => {
  const [kind, setKind] = useState<IExplanation['reasonKind']>(unit.explanation?.reasonKind ?? 'unknown');
  const [status, setStatus] = useState<IExplanation['reasonStatus']>(unit.explanation?.reasonStatus === 'confirmed' ? 'confirmed' : 'hypothesis');
  const [rationale, setRationale] = useState('');
  const [quotes, setQuotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unknown = kind === 'unknown';

  const save = (): void => {
    setBusy(true);
    setError(null);
    setExplanation(unit.id, unit.explanationVersion, {
      reasonKind: kind,
      reasonStatus: unknown ? 'unknown' : status,
      rationale: unknown ? null : rationale.trim() || null,
      fragmentIds: unknown ? [] : [...new Set((quotes.match(UUID_RE) ?? []).map((x) => x.toLowerCase()))],
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
      title={`Причина изменения: ${unit.title}`}
      onClose={onClose}
      onSubmit={save}
      busy={busy}
      footer={
        <div className={form.actions}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" icon="check" loading={busy} disabled={!unknown && rationale.trim() === ''}>
            Записать
          </Button>
        </div>
      }
    >
      <div className={form.stack}>
        <SelectField
          label="Вид причины"
          value={kind}
          onValueChange={(v) => setKind(v as IExplanation['reasonKind'])}
          options={Object.entries(REASON_KIND_LABEL).map(([value, label]) => ({ value, label }))}
        />
        {!unknown ? (
          <>
            <SelectField
              label="Статус"
              value={status}
              onValueChange={(v) => setStatus(v as IExplanation['reasonStatus'])}
              options={[
                { value: 'hypothesis', label: 'Предполагаемая — основание неполное' },
                { value: 'confirmed', label: 'Подтверждена — есть основание' },
              ]}
            />
            <TextAreaField label="Обоснование" value={rationale} onValueChange={setRationale} required rows={3} maxLength={4000} />
            <TextAreaField
              label="Цитаты-основания"
              value={quotes}
              onValueChange={setQuotes}
              rows={2}
              hint="Идентификаторы фрагментов из поиска этапа. Для документа, ответа и поставщика подтверждение требует хотя бы одной цитаты подходящего вида."
            />
          </>
        ) : (
          <Notice tone="info">«Не установлена» — без оснований: изменение останется необъяснённым до решения человека.</Notice>
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Dialog>
  );
};
