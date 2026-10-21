import { useMemo, type FC } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listAdminAudit } from '../api/endpoints';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { Tabs, tabId, tabPanelId, type ITab } from '../components/Tabs';
import { useAuth } from '../hooks/useAuth';
import { OfficePanel } from './admin/office/OfficePanel';
import { OperationsPanel } from './admin/OperationsPanel';
import { AuditLog } from './AuditLog';
import { ContractCreatorsPanel } from './contracts/ContractCreatorsPanel';
import { DestinationsPanel } from './delivery/DestinationsPanel';
import { UsersPanel } from './UsersPanel';
import styles from './TenderPage.module.css';

export const AdminPage: FC = () => {
  const { can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canUsers = can('admin.users');
  const canAudit = can('admin.audit');
  const canContracts = can('admin.contract');
  const canDelivery = can('admin.delivery');

  const tabs = useMemo(() => {
    const result: ITab[] = [];
    if (canUsers) {
      result.push({ id: 'users', label: 'Пользователи', icon: 'users' });
    }
    if (canContracts) {
      result.push({ id: 'contracts', label: 'Создание договоров', icon: 'file-signature' });
    }
    if (canDelivery) {
      result.push({ id: 'delivery', label: 'Назначения размещения', icon: 'folder' });
    }
    if (canAudit) {
      result.push({ id: 'operations', label: 'Состояние', icon: 'monitor' });
      result.push({ id: 'office', label: 'Офис', icon: 'briefcase' });
      result.push({ id: 'audit', label: 'Журнал вне тендеров', icon: 'scroll-text' });
    }
    return result;
  }, [canUsers, canAudit, canContracts, canDelivery]);

  if (tabs.length === 0) {
    return (
      <EmptyState
        icon="shield-x"
        title="Нет доступа"
        text="Раздел администрирования доступен только администраторам портала."
      />
    );
  }

  const requested = searchParams.get('tab');
  const active = tabs.find((tab) => tab.id === requested)?.id ?? tabs[0]?.id ?? 'users';

  return (
    <>
      <PageHeader title="Администрирование" />
      <Tabs tabs={tabs} active={active} onChange={(id) => setSearchParams({ tab: id }, { replace: true })} label="Разделы администрирования" />
      <div className={styles.panel} role="tabpanel" id={tabPanelId(active)} aria-labelledby={tabId(active)}>
        {active === 'users' ? <UsersPanel /> : null}
        {active === 'contracts' ? <ContractCreatorsPanel /> : null}
        {active === 'delivery' ? <DestinationsPanel /> : null}
        {active === 'operations' ? <OperationsPanel /> : null}
        {active === 'office' ? <OfficePanel /> : null}
        {active === 'audit' ? (
          <AuditLog loadPage={listAdminAudit} sourceKey="admin" emptyText="Событий вне тендеров (входы, изменения пользователей) пока нет." />
        ) : null}
      </div>
    </>
  );
};
