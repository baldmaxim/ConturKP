import type { FC } from 'react';
import { listFacts } from '../../api/requirementEndpoints';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { EvidenceLinks } from './EvidenceLinks';
import styles from './Requirements.module.css';

/**
 * Подтверждённые факты реестра (OD-08-3, Р-08-4): вид — из справочника, значение — с основанием письменного
 * текста (D-018). Закрытый перечень 13 типов D-018 в репозитории отсутствует — видов ровно столько, сколько
 * в справочнике.
 */
export const FactsPanel: FC<{ registryId: string }> = ({ registryId }) => {
  const res = useApiResource((signal) => listFacts(registryId, signal), `facts:${registryId}`);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (res.data.items.length === 0) {
    return <EmptyState icon="list-checks" title="Подтверждённых фактов нет" text="Факт появляется после подтверждения кандидата пользователем с правом fact.confirm." />;
  }
  return (
    <ul className={styles.cards}>
      {res.data.items.map((f) => (
        <li key={f.id} className={styles.card}>
          <div className={styles.headLine}>
            <strong>{f.factKindTitle}</strong>
            {f.status === 'superseded' ? <Badge tone="muted" icon="repeat" label="Заменён" /> : <Badge tone="success" icon="user-check" label="Подтверждено человеком" />}
            {f.restricted ? <Badge tone="muted" icon="lock" label="Есть закрытое основание" /> : null}
          </div>
          {f.visible ? <p className={styles.statement}>{`${f.displayValue ?? ''}${f.unit ? ` ${f.unit}` : ''}`}</p> : <p className={styles.restricted}>Значение скрыто: основание из закрытого источника.</p>}
          <p className={styles.muted}>{`Ревизия ${f.seq}`}</p>
          <EvidenceLinks links={f.evidence} />
        </li>
      ))}
    </ul>
  );
};
