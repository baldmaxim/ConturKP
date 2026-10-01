import { useMemo, useState, type FC } from 'react';
import { describeError } from '../../api/errors';
import { listFactKinds, listFragmentStates, proposeFact, proposeRequirement } from '../../api/requirementEndpoints';
import type { TEvidenceRole } from '../../api/requirementTypes';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { ROLE_LABELS } from '../../utils/requirementLabels';
import styles from './Requirements.module.css';

export interface ICandidateDraft {
  statement?: string;
  factKind?: string;
  displayValue?: string;
  unit?: string | null;
  evidence?: { fragmentId: string; role: TEvidenceRole }[];
  derivedFromCandidateId?: string;
  targetRequirementId?: string;
}

const ROLES: TEvidenceRole[] = ['supports', 'clarifies', 'contradicts', 'supersedes_context'];

/**
 * Предложение человека (OD-08-5): формулировка и основания — фрагменты снимка реестра, которые пользователь
 * может читать. Хотя бы одно основание — «Основание» (supports). Правка — новая версия предложения (И-08-5).
 */
export const CandidateForm: FC<{ registryId: string; kind: 'requirement' | 'fact'; draft?: ICandidateDraft; onClose: () => void; onSaved: () => void }> = ({
  registryId,
  kind,
  draft,
  onClose,
  onSaved,
}) => {
  const fragments = useApiResource((signal) => listFragmentStates(registryId, {}, signal), `fragments:${registryId}`);
  const kinds = useApiResource((signal) => (kind === 'fact' ? listFactKinds(signal) : Promise.resolve(null)), `kinds:${kind}`);
  const [statement, setStatement] = useState(draft?.statement ?? '');
  const [rationale, setRationale] = useState('');
  const [factKind, setFactKind] = useState(draft?.factKind ?? '');
  const [displayValue, setDisplayValue] = useState(draft?.displayValue ?? '');
  const [unit, setUnit] = useState(draft?.unit ?? '');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Map<string, TEvidenceRole>>(() => new Map((draft?.evidence ?? []).map((e) => [e.fragmentId, e.role])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { keyFor } = useIdempotencyKey();
  const visible = useMemo(
    () => (fragments.data?.items ?? []).filter((f) => !f.restricted && (!filter || (f.text ?? '').toLowerCase().includes(filter.toLowerCase()))),
    [fragments.data, filter],
  );
  const toggle = (id: string): void => {
    const next = new Map(picked);
    if (next.has(id)) next.delete(id);
    else next.set(id, 'supports');
    setPicked(next);
  };
  const submit = async (): Promise<void> => {
    const evidence = [...picked].map(([fragmentId, role]) => ({ fragmentId, role }));
    if (!evidence.some((e) => e.role === 'supports')) {
      setError('Нужно хотя бы одно основание с ролью «Основание»');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (kind === 'requirement') {
        const body = { statement: statement.trim(), rationale: rationale.trim() || null, evidence, derivedFromCandidateId: draft?.derivedFromCandidateId ?? null, targetRequirementId: draft?.targetRequirementId ?? null };
        await proposeRequirement(registryId, body, keyFor(body));
      } else {
        const body = { factKind, displayValue: displayValue.trim(), normalizedValue: { text: displayValue.trim() }, unit: unit.trim() || null, evidence, derivedFromCandidateId: draft?.derivedFromCandidateId ?? null };
        await proposeFact(registryId, body, keyFor(body));
      }
      onSaved();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={draft?.derivedFromCandidateId ? 'Правка предложения' : kind === 'requirement' ? 'Предложить требование' : 'Предложить факт'}
      onClose={onClose}
      onSubmit={() => void submit()}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Предложить
          </Button>
        </>
      }
    >
      {kind === 'requirement' ? (
        <>
          <TextAreaField label="Формулировка требования" value={statement} onValueChange={setStatement} required rows={3} />
          <TextAreaField label="Обоснование" value={rationale} onValueChange={setRationale} rows={2} />
        </>
      ) : (
        <>
          <SelectField
            label="Вид факта"
            value={factKind}
            options={[{ value: '', label: 'Выберите вид' }, ...(kinds.data?.items ?? []).map((k) => ({ value: k.code, label: k.title }))]}
            onValueChange={setFactKind}
            required
          />
          <TextField label="Значение" value={displayValue} onValueChange={setDisplayValue} required />
          <TextField label="Единица" value={unit} onValueChange={setUnit} />
        </>
      )}
      <TextField label="Найти фрагмент" value={filter} onValueChange={setFilter} hint="Основания — фрагменты снимка реестра, которые вы можете читать" />
      {fragments.loading && !fragments.data ? <LoadingState /> : null}
      <div className={styles.scroll}>
        <ul className={styles.evidence} aria-label="Фрагменты снимка">
          {visible.map((f) => (
            <li key={f.fragmentId} className={styles.evidenceItem}>
              <label className={styles.checkRow}>
                <input type="checkbox" checked={picked.has(f.fragmentId)} onChange={() => toggle(f.fragmentId)} />
                <span className={styles.quote}>{f.text}</span>
              </label>
              {picked.has(f.fragmentId) ? (
                <SelectField
                  label="Роль основания"
                  value={picked.get(f.fragmentId) ?? 'supports'}
                  options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                  onValueChange={(v) => setPicked(new Map(picked).set(f.fragmentId, v as TEvidenceRole))}
                />
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
};
