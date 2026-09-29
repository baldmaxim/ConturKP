import type { FC } from 'react';
import { listTenderContracts } from '../../api/contractEndpoints';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { StatusBadge } from '../../components/StatusBadge';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './Contracts.module.css';

interface ITenderContractsPanelProps {
  tenderId: string;
}

/**
 * Договоры тендера: связи с договорами, по которым у пользователя есть выдача (остальные не называются —
 * fail-closed, D-022 OD-2). Связь не расширяет поиск: документы договора включаются в состав этапа явно.
 */
export const TenderContractsPanel: FC<ITenderContractsPanelProps> = ({ tenderId }) => {
  const res = useApiResource((signal) => listTenderContracts(tenderId, signal), tenderId);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  const items = res.data?.items ?? [];
  return (
    <div className={form.stack}>
      <p className={list.muted}>
        Показаны связи с договорами, доступ к которым вам выдан. Документы договора попадают в поиск этапа только после включения в состав
        источников.
      </p>
      {items.length === 0 ? (
        <EmptyState icon="file-signature" title="Связанных договоров нет" text="Связь подтверждает пользователь с правом «Связь с тендерами» на договоре." />
      ) : (
        <ul className={styles.cards}>
          {items.map((l) => (
            <li key={l.id} className={list.card}>
              <div className={list.cardHead}>
                <AppLink className={list.rowLink} to={`/contracts/${l.contractId}`}>
                  {`${l.contract.number} · ${l.contract.title}`}
                </AppLink>
                <StatusBadge status={l.contract.status} />
              </div>
              <dl className={list.meta}>
                <dt>Связь</dt>
                <dd>{l.status === 'active' ? <Badge tone="success" icon="link" label="Действует" /> : <Badge tone="neutral" icon="archive" dashed label="В архиве" />}</dd>
                <dt>Этап</dt>
                <dd>{l.stageTitle ?? <span className={list.muted}>не указан</span>}</dd>
                <dt>Доступ</dt>
                <dd>{l.contract.capabilities.includes('contract.read') ? 'чтение' : 'только карточка'}</dd>
                <dt>Подтверждена</dt>
                <dd className={list.num}>{`${formatDateTime(l.confirmedAt)} МСК`}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
