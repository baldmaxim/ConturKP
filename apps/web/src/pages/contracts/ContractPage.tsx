import { useMemo, type FC } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getContract } from '../../api/contractEndpoints';
import type { IContract } from '../../api/contractTypes';
import { Badge } from '../../components/Badge';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { PageHeader } from '../../components/PageHeader';
import { StatusBadge } from '../../components/StatusBadge';
import { Tabs, tabId, tabPanelId, type ITab } from '../../components/Tabs';
import { useApiResource } from '../../hooks/useApiResource';
import { useAuth } from '../../hooks/useAuth';
import styles from '../TenderPage.module.css';
import { ContractAccessPanel } from './ContractAccessPanel';
import { ContractCardPanel } from './ContractCardPanel';
import { ContractDocumentsPanel } from './ContractDocumentsPanel';
import { ContractLinksPanel } from './ContractLinksPanel';
import { ContractSearchPanel } from './ContractSearchPanel';

const tabsFor = (contract: IContract, isContractAdmin: boolean): ITab[] => {
  const canRead = contract.capabilities.includes('contract.read');
  const tabs: ITab[] = [];
  if (canRead) {
    tabs.push({ id: 'documents', label: 'Документы', icon: 'files' });
    tabs.push({ id: 'search', label: 'Поиск', icon: 'search' });
  }
  if (contract.capabilities.length > 0) tabs.push({ id: 'tenders', label: 'Тендеры', icon: 'link' });
  tabs.push({ id: 'card', label: 'Карточка', icon: 'file-signature' });
  if (isContractAdmin) tabs.push({ id: 'access', label: 'Доступ', icon: 'key-round' });
  return tabs;
};

/** Договор: документы и редакции, поиск по корпусу договора, связи с тендерами, карточка и доступ. */
export const ContractPage: FC = () => {
  const { contractId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { can } = useAuth();
  const { data: contract, error, loading, reload, setData } = useApiResource((signal) => getContract(contractId, signal), contractId);
  const isContractAdmin = can('admin.contract');
  const tabs = useMemo(() => (contract ? tabsFor(contract, isContractAdmin) : []), [contract, isContractAdmin]);
  const requested = searchParams.get('tab');
  const active = tabs.find((tab) => tab.id === requested)?.id ?? tabs[0]?.id ?? 'card';

  if (loading && !contract) return <LoadingState />;
  if (error && !contract) return <ErrorState error={error} onRetry={reload} notFoundTitle="Договор не найден или нет доступа" />;
  if (!contract) return null;

  return (
    <>
      <PageHeader
        back={{ to: '/contracts', label: 'Договоры' }}
        title={contract.title}
        subtitle={
          <>
            <span className={styles.code}>{contract.number}</span>
            <StatusBadge status={contract.status} />
            {contract.restricted ? <Badge tone="neutral" icon="lock" dashed label="Только карточка: нет права чтения" /> : null}
          </>
        }
      />
      <Tabs tabs={tabs} active={active} onChange={(id) => setSearchParams({ tab: id }, { replace: true })} label="Разделы договора" />
      <div className={styles.panel} role="tabpanel" id={tabPanelId(active)} aria-labelledby={tabId(active)}>
        {active === 'documents' ? <ContractDocumentsPanel contract={contract} /> : null}
        {active === 'search' ? <ContractSearchPanel contractId={contract.id} /> : null}
        {active === 'tenders' ? <ContractLinksPanel contract={contract} /> : null}
        {active === 'card' ? <ContractCardPanel contract={contract} onChanged={(next) => setData(next)} /> : null}
        {active === 'access' ? <ContractAccessPanel contract={contract} onContractChanged={reload} /> : null}
      </div>
    </>
  );
};
