import { useCallback, useState, type FC } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getStage, getTender } from '../api/endpoints';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { Tabs, tabId, tabPanelId, type ITab } from '../components/Tabs';
import { useApiResource } from '../hooks/useApiResource';
import { useUploadQueue } from '../hooks/useUploadQueue';
import form from '../styles/form.module.css';
import { DocumentsTab } from './sources/DocumentsTab';
import { ImportBatchList } from './sources/ImportBatchList';
import { InputEventsLog } from './sources/InputEventsLog';
import { SourceSetTab } from './sources/SourceSetTab';
import { UploadPanel } from './sources/UploadPanel';
import { StageEditor } from './StageEditor';
import styles from './StagePage.module.css';

const TABS: ITab[] = [
  { id: 'params', label: 'Параметры', icon: 'calendar-clock' },
  { id: 'imports', label: 'Импорт', icon: 'upload' },
  { id: 'documents', label: 'Документы', icon: 'files' },
  { id: 'sources', label: 'Состав источников', icon: 'list-checks' },
];

export const StagePage: FC = () => {
  const { stageId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [batchesToken, setBatchesToken] = useState(0);
  const stageRes = useApiResource((signal) => getStage(stageId, signal), stageId);
  const tenderId = stageRes.data?.tenderId ?? '';
  // Карточка тендера нужна для заголовка и возможностей пользователя в тендере ('stage.write', 'source.write').
  const tenderRes = useApiResource(
    (signal) => (tenderId ? getTender(tenderId, signal) : Promise.resolve(null)),
    tenderId,
  );
  // Очередь загрузки живёт на странице этапа: смена вкладки не прерывает отправку файлов.
  const onAccepted = useCallback(() => setBatchesToken((value) => value + 1), []);
  const uploads = useUploadQueue(stageId, onAccepted);

  const requested = searchParams.get('tab');
  const active = TABS.find((tab) => tab.id === requested)?.id ?? 'params';
  const selectTab = (id: string): void => {
    setSearchParams({ tab: id }, { replace: true });
  };

  const stage = stageRes.data;
  if (stageRes.loading && !stage) {
    return <LoadingState />;
  }
  if (stageRes.error && !stage) {
    return <ErrorState error={stageRes.error} onRetry={stageRes.reload} notFoundTitle="Этап не найден или нет доступа" />;
  }
  if (!stage) {
    return null;
  }

  const tender = tenderRes.data;
  const caps = tender?.capabilities ?? [];
  const canWrite = caps.includes('stage.write');
  const canWriteSources = caps.includes('source.write');

  return (
    <>
      <PageHeader
        back={{
          to: `/tenders/${stage.tenderId}?tab=stages`,
          label: tender ? `${tender.code} · ${tender.title}` : 'К тендеру',
        }}
        title={`Этап № ${stage.seq}. ${stage.title}`}
        subtitle={<StatusBadge status={stage.status} />}
      />
      {tenderRes.error ? <ErrorState error={tenderRes.error} onRetry={tenderRes.reload} /> : null}
      <Tabs tabs={TABS} active={active} onChange={selectTab} label="Разделы этапа" />
      <div className={styles.panel} role="tabpanel" id={tabPanelId(active)} aria-labelledby={tabId(active)}>
        {active === 'params' ? (
          <div className={form.stack}>
            <StageEditor stage={stage} canWrite={canWrite} onChanged={(next) => stageRes.setData(next)} />
            <InputEventsLog stageId={stage.id} />
          </div>
        ) : null}
        {active === 'imports' ? (
          <div className={form.stack}>
            {canWriteSources ? <UploadPanel stageId={stage.id} queue={uploads} /> : null}
            <ImportBatchList stageId={stage.id} refreshToken={batchesToken} />
          </div>
        ) : null}
        {active === 'documents' ? <DocumentsTab stageId={stage.id} /> : null}
        {active === 'sources' ? <SourceSetTab stageId={stage.id} canWrite={canWriteSources} /> : null}
      </div>
    </>
  );
};
