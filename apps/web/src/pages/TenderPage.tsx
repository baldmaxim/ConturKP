import { useCallback, useMemo, type FC } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getTender, listTenderAudit } from '../api/endpoints';
import type { ITender } from '../api/types';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { Tabs, tabId, tabPanelId, type ITab } from '../components/Tabs';
import { useApiResource } from '../hooks/useApiResource';
import { useAuth } from '../hooks/useAuth';
import { AuditLog } from './AuditLog';
import { MembersPanel } from './MembersPanel';
import { StagesPanel } from './StagesPanel';
import { TenderCard } from './TenderCard';
import styles from './TenderPage.module.css';

const tabsFor = (tender: ITender): ITab[] => {
  const caps = tender.capabilities;
  const tabs: ITab[] = [];
  if (caps.includes('tender.read')) {
    tabs.push({ id: 'stages', label: 'Этапы', icon: 'layers' });
  }
  tabs.push({ id: 'card', label: 'Карточка', icon: 'briefcase' });
  tabs.push({ id: 'members', label: 'Участники', icon: 'users' });
  if (caps.includes('audit.read')) {
    tabs.push({ id: 'audit', label: 'Журнал', icon: 'scroll-text' });
  }
  return tabs;
};

export const TenderPage: FC = () => {
  const { tenderId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { can } = useAuth();
  const { data: tender, error, loading, reload, setData } = useApiResource((signal) => getTender(tenderId, signal), tenderId);

  const tabs = useMemo(() => (tender ? tabsFor(tender) : []), [tender]);
  const requested = searchParams.get('tab');
  const active = tabs.find((tab) => tab.id === requested)?.id ?? tabs[0]?.id ?? 'card';

  const selectTab = (id: string): void => {
    setSearchParams({ tab: id }, { replace: true });
  };

  const loadAudit = useCallback(
    (cursor: string | null, limit: number, signal?: AbortSignal) => listTenderAudit(tenderId, cursor, limit, signal),
    [tenderId],
  );

  if (loading && !tender) {
    return <LoadingState />;
  }
  if (error && !tender) {
    return <ErrorState error={error} onRetry={reload} notFoundTitle="Тендер не найден или нет доступа" />;
  }
  if (!tender) {
    return null;
  }

  const caps = tender.capabilities;

  return (
    <>
      <PageHeader
        back={{ to: '/', label: 'Тендеры' }}
        title={tender.title}
        subtitle={
          <>
            <span className={styles.code}>{tender.code}</span>
            <StatusBadge status={tender.status} />
          </>
        }
      />
      <Tabs tabs={tabs} active={active} onChange={selectTab} label="Разделы тендера" />
      <div className={styles.panel} role="tabpanel" id={tabPanelId(active)} aria-labelledby={tabId(active)}>
        {active === 'stages' ? <StagesPanel tenderId={tender.id} canManage={caps.includes('stage.manage')} /> : null}
        {active === 'card' ? <TenderCard tender={tender} onChanged={(next) => setData(next)} /> : null}
        {active === 'members' ? (
          <MembersPanel
            tenderId={tender.id}
            canAdmin={caps.includes('admin.tender')}
            canListUsers={can('admin.users')}
            onTenderChanged={reload}
          />
        ) : null}
        {active === 'audit' ? (
          <AuditLog loadPage={loadAudit} sourceKey={`tender:${tender.id}`} emptyText="По этому тендеру событий в журнале пока нет." />
        ) : null}
      </div>
    </>
  );
};
