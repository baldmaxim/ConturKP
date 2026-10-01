import { useState, type FC } from 'react';
import { getCalculationLines, getCalculationPositions, listCalculationRevisions } from '../../api/calculationEndpoints';
import { newUuid } from '../../api/client';
import { describeError, stateConflictCurrent } from '../../api/errors';
import { recordCoverage, type ICoverageObjectInput } from '../../api/requirementEndpoints';
import type { IRequirementCard, TCoverageState } from '../../api/requirementTypes';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { useApiResource } from '../../hooks/useApiResource';
import { COVERAGE_LABELS } from '../../utils/requirementLabels';
import styles from './Requirements.module.css';

const STATES: TCoverageState[] = ['covered', 'partial', 'uncovered', 'not_applicable', 'needs_review'];

/**
 * Оценка покрытия текущей ревизии требования (Р-08-2): состояние и объекты — позиция или строка ревизии расчёта
 * (комплексная расценка — позиция без строки, A05), решение по требованию, ручное подтверждение с пояснением.
 * Новая оценка не меняет ревизию требования; история оценок сохраняется. Несовпадение единицы требования и строки
 * расчёта сервер возвращает явно (R08-01): «покрыто» и «частично» записываются только с пояснением.
 */
interface IUnitIssue {
  index: number;
  requirementUnits: string[];
  calculationUnit: string | null;
}

const unitIssuesOf = (e: unknown): IUnitIssue[] | null => {
  const current = stateConflictCurrent(e) as { reason?: string; objects?: IUnitIssue[] } | null;
  return current?.reason === 'unit_mismatch' ? (current.objects ?? []) : null;
};

export const CoverageForm: FC<{ card: IRequirementCard; onSaved: (next: IRequirementCard) => void }> = ({ card, onSaved }) => {
  const revisions = useApiResource((signal) => listCalculationRevisions(card.stageId, signal), `calc:${card.stageId}`);
  const [state, setState] = useState<TCoverageState>('covered');
  const [reason, setReason] = useState('');
  const [objects, setObjects] = useState<(ICoverageObjectInput & { label: string })[]>([]);
  const [calcId, setCalcId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [itemId, setItemId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unitIssues, setUnitIssues] = useState<IUnitIssue[] | null>(null);
  const [unitReason, setUnitReason] = useState('');
  const positions = useApiResource((signal) => (calcId ? getCalculationPositions(calcId, null, signal) : Promise.resolve(null)), `pos:${calcId}`);
  const lines = useApiResource((signal) => (calcId && positionId ? getCalculationLines(calcId, positionId, null, signal) : Promise.resolve(null)), `lines:${calcId}:${positionId}`);
  const withObjects = state === 'covered' || state === 'partial';
  // Состав объектов изменился — прежний ответ о единицах устарел.
  const changeObjects = (next: (ICoverageObjectInput & { label: string })[]): void => {
    setObjects(next);
    setUnitIssues(null);
    setUnitReason('');
  };
  const addCalc = (): void => {
    const pos = positions.data?.items.find((p) => p.externalPositionId === positionId);
    if (!calcId || !pos) return;
    const line = lines.data?.items.find((l) => l.externalItemId === itemId);
    changeObjects([
      ...objects,
      {
        type: 'calculation_revision',
        calculationRevisionId: calcId,
        externalPositionId: positionId,
        externalItemId: itemId || null,
        match: itemId ? 'explicit_line' : 'complex_rate',
        label: `Позиция ${pos.positionNumber} ${pos.workName}${line ? ` · строка ${line.description ?? line.workName ?? line.materialName ?? ''}` : ' · комплексная расценка'}`,
      },
    ]);
    setItemId('');
  };
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        state,
        reason: reason.trim() || null,
        unitMismatchReason: unitIssues && unitReason.trim() ? unitReason.trim() : null,
        objects: withObjects ? objects.map(({ label: _label, ...o }) => o) : [],
      };
      onSaved(await recordCoverage(card.currentRevisionId, body, newUuid()));
      setObjects([]);
      setReason('');
      setUnitIssues(null);
      setUnitReason('');
    } catch (e) {
      const issues = unitIssuesOf(e);
      if (issues) setUnitIssues(issues);
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const active = card.decisions.filter((d) => d.status === 'active');
  return (
    <div className={styles.stack}>
      <SelectField label="Состояние покрытия" value={state} options={STATES.map((s) => ({ value: s, label: COVERAGE_LABELS[s] }))} onValueChange={(v) => setState(v as TCoverageState)} />
      <TextAreaField label="Причина" value={reason} onValueChange={setReason} rows={2} hint={state === 'not_applicable' ? 'Обязательна для «не применимо»' : undefined} />
      {withObjects ? (
        <>
          <SelectField
            label="Ревизия расчёта"
            value={calcId}
            options={[{ value: '', label: 'Выберите ревизию' }, ...(revisions.data?.items ?? []).map((r) => ({ value: r.id, label: `Ревизия ${r.seq} · ${r.kind === 'provisional' ? 'предварительная (X-01)' : 'подтверждённая'}` }))]}
            onValueChange={(v) => {
              setCalcId(v);
              setPositionId('');
              setItemId('');
            }}
          />
          {calcId ? (
            <SelectField
              label="Позиция"
              value={positionId}
              options={[{ value: '', label: 'Выберите позицию' }, ...(positions.data?.items ?? []).filter((p) => !p.isSection).map((p) => ({ value: p.externalPositionId, label: `${p.positionNumber} ${p.workName}` }))]}
              onValueChange={(v) => {
                setPositionId(v);
                setItemId('');
              }}
            />
          ) : null}
          {positionId ? (
            <SelectField
              label="Строка"
              value={itemId}
              options={[{ value: '', label: 'Комплексная расценка (без строки, A05)' }, ...(lines.data?.items ?? []).map((l) => ({ value: l.externalItemId, label: l.description ?? l.workName ?? l.materialName ?? l.itemType }))]}
              onValueChange={setItemId}
            />
          ) : null}
          <div className={styles.actions}>
            <Button variant="secondary" icon="plus" disabled={!positionId} onClick={addCalc}>
              Добавить позицию расчёта
            </Button>
            {active.map((d) => (
              <Button key={d.id} variant="ghost" icon="plus" onClick={() => changeObjects([...objects, { type: 'decision', decisionId: d.id, label: `Решение: ${d.statement ?? 'скрыто'}` }])}>
                {`Решение от ${d.decidedAt.slice(0, 10)}`}
              </Button>
            ))}
          </div>
          <TextAreaField label="Ручное подтверждение" value={note} onValueChange={setNote} rows={2} />
          <div className={styles.actions}>
            <Button
              variant="ghost"
              icon="plus"
              disabled={!note.trim()}
              onClick={() => {
                changeObjects([...objects, { type: 'manual_confirmation', note: note.trim(), label: `Ручное подтверждение: ${note.trim()}` }]);
                setNote('');
              }}
            >
              Добавить вручную
            </Button>
          </div>
          <ul className={styles.evidence} aria-label="Объекты покрытия">
            {objects.map((o, i) => (
              <li key={`${o.type}:${i}`} className={styles.evidenceItem}>
                <span>{o.label}</span>
                <Button variant="ghost" icon="x" onClick={() => changeObjects(objects.filter((_, j) => j !== i))}>
                  Убрать
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {unitIssues ? (
        <>
          <Notice tone="warning">
            {unitIssues
              .map((u) => `${objects[u.index]?.label ?? 'Позиция расчёта'}: единица требования ${u.requirementUnits.join(', ')}, в расчёте ${u.calculationUnit ?? '—'}`)
              .join('; ')}
          </Notice>
          <TextAreaField label="Пояснение к несовпадению единиц" value={unitReason} onValueChange={setUnitReason} rows={2} required hint="Почему строка расчёта с другой единицей покрывает требование" />
        </>
      ) : null}
      {error && !unitIssues ? <Notice tone="danger">{error}</Notice> : null}
      <div className={styles.actions}>
        <Button variant="primary" icon="check" loading={busy} disabled={(withObjects && objects.length === 0) || (unitIssues !== null && !unitReason.trim())} onClick={() => void submit()}>
          Записать оценку
        </Button>
      </div>
    </div>
  );
};
