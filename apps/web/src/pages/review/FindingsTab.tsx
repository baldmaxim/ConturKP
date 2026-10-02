import { useState, type FC } from 'react';
import { listFindings } from '../../api/reviewEndpoints';
import type { IFindingListItem } from '../../api/reviewTypes';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { cx } from '../../utils/cx';
import { FINDING_STATUS_LABELS, SEVERITY_LABELS } from '../../utils/reviewLabels';
import { FindingDetail } from './FindingDetail';
import styles from './Review.module.css';

interface IFindingsTabProps {
  stageId: string;
  tenderId: string;
}

const STATUS_OPTIONS = [{ value: '', label: 'Все статусы' }, ...Object.entries(FINDING_STATUS_LABELS).map(([value, l]) => ({ value, label: l.label }))];
const SEVERITY_OPTIONS = [{ value: '', label: 'Любая критичность' }, ...Object.entries(SEVERITY_LABELS).map(([value, l]) => ({ value, label: l.label }))];

/**
 * Разногласия этапа (этап 09): замечания проверки с двумя основаниями, затронутыми позициями, критичностью, действием и
 * ответственным; разногласие — четыре независимые оси (I09). Замечание закрывает человек решением, не система.
 */
export const FindingsTab: FC<IFindingsTabProps> = ({ stageId, tenderId }) => {
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const res = useApiResource((signal) => listFindings(stageId, { status, severity, kind }, signal), `${stageId}:${status}:${severity}:${kind}`);

  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const items = res.data.items;
  const kinds = [...new Map(items.map((f) => [f.kind, f.kindTitle])).entries()];

  return (
    <div className={styles.stack}>
      <div className={styles.filters}>
        <SelectField label="Статус" value={status} onValueChange={setStatus} options={STATUS_OPTIONS} />
        <SelectField label="Критичность" value={severity} onValueChange={setSeverity} options={SEVERITY_OPTIONS} />
        <SelectField label="Вид" value={kind} onValueChange={setKind} options={[{ value: '', label: 'Все виды' }, ...kinds.map(([value, label]) => ({ value, label }))]} />
      </div>
      {items.length === 0 ? (
        <EmptyState icon="list-checks" title="Замечаний нет" text="Замечания появляются после проверки этапа или добавляются человеком. Отсутствие замечаний само по себе не значит, что всё проверено — смотрите отчёт проверки." />
      ) : (
        <div className={styles.layout}>
          <ul className={styles.list} aria-label="Замечания">
            {items.map((f) => (
              <li key={f.id}>
                <FindingRow finding={f} selected={selected === f.id} onSelect={() => setSelected(f.id)} />
              </li>
            ))}
          </ul>
          {selected ? (
            <FindingDetail
              key={selected}
              findingId={selected}
              tenderId={tenderId}
              onChanged={res.reload}
              onClose={() => setSelected(null)}
            />
          ) : (
            <p className={styles.muted}>Выберите замечание, чтобы увидеть обе стороны, историю и разногласие.</p>
          )}
        </div>
      )}
    </div>
  );
};

const FindingRow: FC<{ finding: IFindingListItem; selected: boolean; onSelect: () => void }> = ({ finding: f, selected, onSelect }) => (
  <button type="button" className={cx(styles.cardButton, selected && styles.selected, f.status === 'stale' && styles.stale)} onClick={onSelect} aria-pressed={selected}>
    <span className={styles.headLine}>
      <Badge {...FINDING_STATUS_LABELS[f.status]} />
      <Badge label={SEVERITY_LABELS[f.severity].label} icon="file-exclamation-point" tone={SEVERITY_LABELS[f.severity].tone} />
      {f.restricted ? <Badge label="основания закрыты" icon="lock" tone="muted" /> : null}
      {f.discrepancyId ? <Badge label="разногласие" icon="layers" tone="info" /> : null}
    </span>
    <span className={styles.title}>{f.title}</span>
    <span className={styles.muted}>
      {[f.kindTitle, f.requirements.length ? f.requirements.join(', ') : null, f.positions.length ? `позиций: ${f.positions.length}` : null, f.owner ? `ответственный: ${f.owner.name}` : null]
        .filter(Boolean)
        .join(' · ')}
    </span>
    {f.action ? <span className={styles.muted}>{`Действие: ${f.action}`}</span> : null}
  </button>
);
