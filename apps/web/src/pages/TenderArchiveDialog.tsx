import { useState, type FC } from 'react';
import { updateTender } from '../api/endpoints';
import { describeError, hasCode } from '../api/errors';
import type { ITender, TTenderOutcome } from '../api/types';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Notice } from '../components/Notice';
import { SelectField } from '../components/SelectField';
import form from '../styles/form.module.css';
import { TENDER_OUTCOME_LABELS } from '../utils/labels';

interface ITenderArchiveDialogProps {
  tender: ITender;
  onClose: () => void;
  onSaved: (tender: ITender) => void;
}

export const TenderArchiveDialog: FC<ITenderArchiveDialogProps> = ({ tender, onClose, onSaved }) => {
  const [outcome, setOutcome] = useState<TTenderOutcome | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const save = async (): Promise<void> => {
    if (!outcome || saving || stale) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await updateTender(tender.id, tender.rowVersion, { status: 'archived', outcome }));
    } catch (reason) {
      if (hasCode(reason, 'VERSION_CONFLICT')) {
        setStale(true);
        setError('Тендер изменён другим пользователем. Закройте окно и обновите данные перед архивированием.');
      } else setError(describeError(reason));
    } finally { setSaving(false); }
  };
  return (
    <Dialog title="В архив" onClose={onClose} busy={saving} onSubmit={() => void save()} footer={
      <>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Отмена</Button>
        <Button variant="primary" type="submit" icon="archive" loading={saving} disabled={!outcome || stale}>В архив</Button>
      </>
    }>
      <div className={form.stack}>
        <p>{tender.code} · {tender.title}</p>
        <p>Тендер сохранится со всеми документами и будет доступен в архиве.</p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <SelectField label="Результат тендера" required value={outcome} placeholder="Выберите результат" options={[
          { value: 'won', label: TENDER_OUTCOME_LABELS.won },
          { value: 'lost', label: TENDER_OUTCOME_LABELS.lost },
        ]} onValueChange={(value) => setOutcome(value === 'won' || value === 'lost' ? value : '')} disabled={saving || stale} />
      </div>
    </Dialog>
  );
};
