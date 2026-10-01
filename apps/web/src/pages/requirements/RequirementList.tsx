import type { FC } from 'react';
import { listRequirements } from '../../api/requirementEndpoints';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { coverageBadge } from '../../utils/requirementLabels';
import styles from './Requirements.module.css';

/**
 * Реестр: подтверждённые требования активного реестра. Формулировка из закрытого источника не показывается —
 * только код, статус и пометка о закрытом основании (Р-08-5).
 */
export const RequirementList: FC<{ registryId: string }> = ({ registryId }) => {
  const res = useApiResource((signal) => listRequirements(registryId, signal), `requirements:${registryId}`);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const items = res.data.items;
  if (items.length === 0) {
    return <EmptyState icon="list-checks" title="Подтверждённых требований нет" text="Требование появляется только после подтверждения кандидата человеком." />;
  }
  return (
    <ul className={styles.cards}>
      {items.map((r) => (
        <li key={r.id} className={styles.card}>
          <div className={styles.headLine}>
            <AppLink to={`/requirements/${r.id}`} className={styles.code}>
              {r.code}
            </AppLink>
            {r.status === 'superseded' ? (
              <Badge tone="muted" icon="repeat" label={`Заменено ${r.supersededByCode ?? ''}`.trim()} />
            ) : (
              <Badge tone="success" icon="user-check" label="Подтверждено человеком" />
            )}
            {coverageBadge(r.coverageState)}
            {r.restricted ? <Badge tone="muted" icon="lock" label="Есть закрытое основание" /> : null}
          </div>
          {r.visible ? (
            <p className={styles.statement}>{r.statement}</p>
          ) : (
            <p className={styles.restricted}>Формулировка скрыта: основание из источника, на который у вас нет права.</p>
          )}
          <p className={styles.muted}>{`Ревизия ${r.seq} · оснований: ${Object.values(r.evidenceCounts).reduce((a, b) => a + b, 0)}`}</p>
        </li>
      ))}
    </ul>
  );
};
