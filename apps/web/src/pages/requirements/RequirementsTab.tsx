import { useState, type FC } from 'react';
import { createRegistry, getRegistryView } from '../../api/requirementEndpoints';
import { listEvidenceScopes } from '../../api/searchEndpoints';
import { describeError } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextAreaField } from '../../components/TextAreaField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import { AnalysisPanel } from './AnalysisPanel';
import { CandidateQueue } from './CandidateQueue';
import { CompletenessPanel } from './CompletenessPanel';
import { FactsPanel } from './FactsPanel';
import { RequirementList } from './RequirementList';
import { StageRecordsPanel } from './StageRecordsPanel';
import styles from './Requirements.module.css';

type TSection = 'list' | 'candidates' | 'facts' | 'completeness' | 'analysis' | 'records';
const SECTIONS: { id: TSection; label: string }[] = [
  { id: 'list', label: 'Реестр' },
  { id: 'candidates', label: 'Кандидаты' },
  { id: 'facts', label: 'Факты' },
  { id: 'completeness', label: 'Полнота' },
  { id: 'analysis', label: 'Анализ моделью' },
  { id: 'records', label: 'Допущения и вопросы' },
];

const RegistryDialog: FC<{ stageId: string; currentScopeId: string | null; onClose: () => void; onCreated: () => void }> = ({ stageId, currentScopeId, onClose, onCreated }) => {
  const scopes = useApiResource((signal) => listEvidenceScopes(stageId, signal), `scopes:${stageId}`);
  const [scopeId, setScopeId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { keyFor } = useIdempotencyKey();
  const toast = useToast();
  const options = (scopes.data?.items ?? []).filter((s) => s.id !== currentScopeId).map((s) => ({ value: s.id, label: `Снимок от ${formatDateTime(s.createdAt)} МСК · единиц: ${s.units ?? '—'}` }));
  const submit = async (): Promise<void> => {
    if (!scopeId || !reason.trim()) {
      setError('Выберите снимок и укажите причину');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await createRegistry(stageId, { evidenceScopeId: scopeId, reason: reason.trim() }, keyFor({ scopeId, reason }));
      toast.push({ kind: 'success', text: `Реестр № ${r.seq} активен. Перенесено требований: ${r.carry.requirementsCarried ?? 0}, кандидатами: ${r.carry.requirementsAsCandidates ?? 0}` });
      onCreated();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={currentScopeId ? 'Перенести реестр на новый снимок' : 'Создать реестр требований'}
      onClose={onClose}
      onSubmit={() => void submit()}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {currentScopeId ? 'Перенести' : 'Создать'}
          </Button>
        </>
      }
    >
      {scopes.loading && !scopes.data ? <LoadingState /> : null}
      {options.length === 0 && !scopes.loading ? (
        <Notice tone="warning">Нет подходящего снимка области. Зафиксируйте снимок на вкладке «Поиск».</Notice>
      ) : (
        <SelectField label="Снимок области доказательств" value={scopeId} options={[{ value: '', label: 'Выберите снимок' }, ...options]} onValueChange={setScopeId} required />
      )}
      <TextAreaField label="Причина" value={reason} onValueChange={setReason} required rows={2} hint="Попадает в журнал: почему реестр закрепляется на этом снимке" />
      {currentScopeId ? (
        <Notice tone="info">Прежний реестр не меняется. Требования, все основания которых есть в новом снимке, переносятся новой ревизией; остальные — кандидатами.</Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
};

/**
 * Требования этапа (D-026): один активный реестр на снимке области; разделы — реестр, кандидаты с
 * последовательным обходом, факты, полнота по фрагментам, прогоны модели, допущения и вопросы.
 */
export const RequirementsTab: FC<{ stageId: string; caps: string[] }> = ({ stageId, caps }) => {
  const [version, setVersion] = useState(0);
  const res = useApiResource((signal) => getRegistryView(stageId, signal), `registry:${stageId}:${version}`);
  const [section, setSection] = useState<TSection>('list');
  const [dialog, setDialog] = useState(false);
  const reload = (): void => setVersion((v) => v + 1);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const { active, registries, completeness, model } = res.data;
  const canManage = caps.includes('requirement.manage');
  return (
    <div className={styles.stack}>
      {active ? (
        <section className={styles.card} aria-label="Активный реестр">
          <div className={styles.headLine}>
            <strong>{`Реестр № ${active.seq}`}</strong>
            <Badge tone="success" icon="check" label="Активный" />
            {completeness && completeness.unreviewed_units > 0 ? (
              <Badge tone="warning" icon="hourglass" dashed label={`Не просмотрено фрагментов: ${completeness.unreviewed_units}`} />
            ) : completeness ? (
              <Badge tone="success" icon="list-checks" label="Все фрагменты просмотрены" />
            ) : null}
            {!model.configured ? <Badge tone="muted" icon="server-off" label="Модель не настроена" /> : null}
          </div>
          <p className={styles.muted}>{`Снимок области от ${formatDateTime(active.scopeCreatedAt)} МСК · ${active.reason}${registries.length > 1 ? ` · прежних реестров: ${registries.length - 1}` : ''}`}</p>
          {canManage ? (
            <div className={styles.actions}>
              <Button variant="secondary" icon="repeat" onClick={() => setDialog(true)}>
                Перенести на новый снимок
              </Button>
            </div>
          ) : null}
        </section>
      ) : (
        <EmptyState
          icon="list-checks"
          title="Реестр требований не создан"
          text={canManage ? 'Реестр закрепляется на снимке области доказательств этапа.' : 'Реестр создаёт руководитель тендера.'}
          action={canManage ? <Button variant="primary" icon="plus" onClick={() => setDialog(true)}>Создать реестр</Button> : undefined}
        />
      )}
      {active ? (
        <>
          <nav className={styles.segments} aria-label="Разделы требований">
            {SECTIONS.map((s) => (
              <Button key={s.id} variant={section === s.id ? 'primary' : 'secondary'} aria-pressed={section === s.id} onClick={() => setSection(s.id)}>
                {s.label}
              </Button>
            ))}
          </nav>
          {section === 'list' ? <RequirementList registryId={active.id} /> : null}
          {section === 'candidates' ? <CandidateQueue registryId={active.id} caps={caps} onChanged={reload} /> : null}
          {section === 'facts' ? <FactsPanel registryId={active.id} /> : null}
          {section === 'completeness' ? <CompletenessPanel registryId={active.id} caps={caps} onChanged={reload} /> : null}
          {section === 'analysis' ? <AnalysisPanel registryId={active.id} canRun={caps.includes('analysis.run') && model.configured} /> : null}
          {section === 'records' ? <StageRecordsPanel stageId={stageId} caps={caps} /> : null}
        </>
      ) : null}
      {dialog ? (
        <RegistryDialog
          stageId={stageId}
          currentScopeId={active?.evidenceScopeId ?? null}
          onClose={() => setDialog(false)}
          onCreated={() => {
            setDialog(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
};
