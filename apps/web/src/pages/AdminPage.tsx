import { useMemo, type FC } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listAdminAudit } from '../api/endpoints';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { Tabs, tabId, tabPanelId, type ITab } from '../components/Tabs';
import { useAuth } from '../hooks/useAuth';
import { AuditLog } from './AuditLog';
import { UsersPanel } from './UsersPanel';
import styles from './TenderPage.module.css';

export const AdminPage: FC = () => {
  const { can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canUsers = can('admin.users');
  const canAudit = can('admin.audit');

  const tabs = useMemo(() => {
    const result: ITab[] = [];
    if (canUsers) {
      result.push({ id: 'users', label: 'Пользователи', icon: 'users' });
    }
    if (canAudit) {
      result.push({ id: 'audit', label: 'Журнал вне тендеров', icon: 'scroll-text' });
    }
    return result;
  }, [canUsers, canAudit]);

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
        {active === 'audit' ? (
          <AuditLog loadPage={listAdminAudit} sourceKey="admin" emptyText="Событий вне тендеров (входы, изменения пользователей) пока нет." />
        ) : null}
      </div>
    </>
  );
};
