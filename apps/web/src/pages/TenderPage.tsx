import { useCallback, useMemo, useState, type FC } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getTender, listTenderAudit, updateTender } from '../api/endpoints';
import type { ITender } from '../api/types';
import { describeError } from '../api/errors';
import { Button } from '../components/Button';
import { useToast } from '../hooks/useToast';
import { TenderArchiveDialog } from './TenderArchiveDialog';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { Tabs, tabId, tabPanelId, type ITab } from '../components/Tabs';
import { useApiResource } from '../hooks/useApiResource';
import { useAuth } from '../hooks/useAuth';
import { AuditLog } from './AuditLog';
import { AppLink } from '../components/AppLink';
import { ReleaseComparisonPanel } from './comparison/ReleaseComparisonPanel';
import { TenderMailPanel } from './communications/TenderMailPanel';
import { TenderNegotiationsPanel } from './communications/TenderNegotiationsPanel';
import { TenderQaPanel } from './communications/TenderQaPanel';
import { TenderContractsPanel } from './contracts/TenderContractsPanel';
import { IntakeChannelsPanel } from './intake/IntakeChannelsPanel';
import { MembersPanel } from './MembersPanel';
import { StagesPanel } from './StagesPanel';
import { SourcePriorityPanel } from './review/SourcePriorityPanel';
import { TenderCard } from './TenderCard';
import styles from './TenderPage.module.css';

const tabsFor = (tender: ITender, canAdminIntake: boolean): ITab[] => {
  const caps = tender.capabilities;
  const tabs: ITab[] = [];
  if (caps.includes('tender.read')) {
    tabs.push({ id: 'stages', label: 'Этапы', icon: 'layers' });
  }
  if (caps.includes('tender.read') || canAdminIntake) {
    tabs.push({ id: 'intake', label: 'Каналы поступления', icon: 'inbox' });
  }
  if (caps.includes('tender.read')) {
    tabs.push({ id: 'contracts', label: 'Договоры', icon: 'file-signature' });
    tabs.push({ id: 'mail', label: 'Переписка', icon: 'mail' });
    tabs.push({ id: 'qa', label: 'Вопросы и ответы', icon: 'message-square' });
    tabs.push({ id: 'negotiations', label: 'Переговоры', icon: 'mic' });
    tabs.push({ id: 'priority', label: 'Приоритет источников', icon: 'list-checks' });
    tabs.push({ id: 'compare', label: 'Сравнение выпусков', icon: 'copy' });
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
  const toast = useToast();
  const [archiving, setArchiving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const { can } = useAuth();
  const { data: tender, error, loading, reload, setData } = useApiResource((signal) => getTender(tenderId, signal), tenderId);

  const canAdminIntake = can('admin.intake');
  const tabs = useMemo(() => (tender ? tabsFor(tender, canAdminIntake) : []), [tender, canAdminIntake]);
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
  const restore = async (): Promise<void> => {
    if (restoring) return;
    setRestoring(true);
    try { setData(await updateTender(tender.id, tender.rowVersion, { status: 'active', outcome: null })); toast.push({ kind: 'success', text: 'Тендер возвращён в действующие.' }); }
    catch (reason) { toast.push({ kind: 'error', text: describeError(reason) }); reload(); }
    finally { setRestoring(false); }
  };

  return (
    <>
      <PageHeader
        back={{ to: tender.status === 'archived' ? '/?status=archived' : '/', label: 'Тендеры' }}
        title={tender.title}
        actions={<>{caps.includes('tender.read') ? <AppLink to={'/history?tender='+tender.id}>Хронология тендера →</AppLink> : null}{caps.includes('admin.tender') ? <Button icon={tender.status === 'active' ? 'archive' : 'undo-2'} loading={restoring} onClick={() => tender.status === 'active' ? setArchiving(true) : void restore()}>{tender.status === 'active' ? 'В архив' : 'Вернуть в действующие'}</Button> : null}</>}
        subtitle={
          <>
            <span className={styles.code}>{tender.code}</span>
            <StatusBadge status={tender.status} outcome={tender.outcome} />
          </>
        }
      />
      {archiving ? <TenderArchiveDialog tender={tender} onClose={() => { setArchiving(false); reload(); }} onSaved={(next) => { setData(next); setArchiving(false); toast.push({ kind: 'success', text: 'Тендер перенесён в архив.' }); }} /> : null}
      <Tabs tabs={tabs} active={active} onChange={selectTab} label="Разделы тендера" />
      <div className={styles.panel} role="tabpanel" id={tabPanelId(active)} aria-labelledby={tabId(active)}>
        {active === 'stages' ? <StagesPanel tenderId={tender.id} canManage={caps.includes('stage.manage')} /> : null}
        {active === 'intake' ? (
          <IntakeChannelsPanel
            tenderId={tender.id}
            canAdmin={canAdminIntake}
            canScan={caps.includes('source.write')}
            canDisable={caps.includes('hold.resolve')}
          />
        ) : null}
        {active === 'contracts' ? <TenderContractsPanel tenderId={tender.id} /> : null}
        {active === 'mail' ? <TenderMailPanel tenderId={tender.id} /> : null}
        {active === 'qa' ? <TenderQaPanel tenderId={tender.id} canImport={caps.includes('source.write')} /> : null}
        {active === 'negotiations' ? <TenderNegotiationsPanel tenderId={tender.id} canImport={caps.includes('source.write')} /> : null}
        {active === 'priority' ? <SourcePriorityPanel tenderId={tender.id} /> : null}
        {active === 'compare' ? <ReleaseComparisonPanel tenderId={tender.id} /> : null}
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
