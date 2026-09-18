import type { FC } from 'react';
import { useParams } from 'react-router-dom';
import { getStage, getTender } from '../api/endpoints';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { useApiResource } from '../hooks/useApiResource';
import { StageEditor } from './StageEditor';

export const StagePage: FC = () => {
  const { stageId = '' } = useParams();
  const stageRes = useApiResource((signal) => getStage(stageId, signal), stageId);
  const tenderId = stageRes.data?.tenderId ?? '';
  // Карточка тендера нужна для заголовка и возможностей пользователя в тендере ('stage.write').
  const tenderRes = useApiResource(
    (signal) => (tenderId ? getTender(tenderId, signal) : Promise.resolve(null)),
    tenderId,
  );

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
  const canWrite = tender?.capabilities.includes('stage.write') ?? false;

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
      <StageEditor stage={stage} canWrite={canWrite} onChanged={(next) => stageRes.setData(next)} />
    </>
  );
};
