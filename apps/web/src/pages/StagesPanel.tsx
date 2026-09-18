import { useState, type FC, type ReactNode } from 'react';
import { listStages } from '../api/endpoints';
import type { IStage } from '../api/types';
import { AppLink } from '../components/AppLink';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { StatusBadge } from '../components/StatusBadge';
import { useApiResource } from '../hooks/useApiResource';
import { useAppNavigate } from '../hooks/useAppNavigate';
import { useToast } from '../hooks/useToast';
import { formatDateTime } from '../utils/datetime';
import form from '../styles/form.module.css';
import list from '../styles/list.module.css';
import { CreateStageDialog } from './CreateStageDialog';

interface IStagesPanelProps {
  tenderId: string;
  canManage: boolean;
}

export const StagesPanel: FC<IStagesPanelProps> = ({ tenderId, canManage }) => {
  const toast = useToast();
  const navigate = useAppNavigate();
  const [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useApiResource((signal) => listStages(tenderId, signal), tenderId);

  const onCreated = (stage: IStage): void => {
    setCreating(false);
    toast.push({ kind: 'success', text: `Этап «${stage.title}» создан.` });
    navigate(`/stages/${stage.id}`);
  };

  const deadlineText = (stage: IStage): ReactNode =>
    stage.submissionDeadline ? (
      `${formatDateTime(stage.submissionDeadline)} МСК`
    ) : (
      <span className={list.muted}>срок не задан</span>
    );

  const createButton = canManage ? (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      Создать этап
    </Button>
  ) : null;

  const renderBody = (): ReactNode => {
    if (loading && !data) {
      return <LoadingState />;
    }
    if (error) {
      return <ErrorState error={error} onRetry={reload} />;
    }
    const items = [...(data?.items ?? [])].sort((a, b) => a.seq - b.seq);
    if (items.length === 0) {
      return (
        <EmptyState
          icon="layers"
          title="Этапов пока нет"
          text={
            canManage
              ? 'Создайте первый этап тендера: название и срок подачи.'
              : 'Этапы создаёт руководитель тендера.'
          }
          action={createButton}
        />
      );
    }
    return (
      <>
        <div className={list.tableWrap}>
          <table className={list.table}>
            <thead>
              <tr>
                <th scope="col" className={list.right}>
                  №
                </th>
                <th scope="col">Название</th>
                <th scope="col">Срок подачи</th>
                <th scope="col">Статус</th>
                <th scope="col">Изменён, МСК</th>
              </tr>
            </thead>
            <tbody>
              {items.map((stage) => (
                <tr key={stage.id}>
                  <td className={`${list.num} ${list.right}`}>{stage.seq}</td>
                  <td>
                    <AppLink className={list.rowLink} to={`/stages/${stage.id}`}>
                      {stage.title}
                    </AppLink>
                  </td>
                  <td className={list.num}>{deadlineText(stage)}</td>
                  <td>
                    <StatusBadge status={stage.status} />
                  </td>
                  <td className={list.num}>{formatDateTime(stage.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className={list.cards}>
          {items.map((stage) => (
            <li key={stage.id} className={list.card}>
              <div className={list.cardHead}>
                <AppLink className={list.rowLink} to={`/stages/${stage.id}`}>
                  {`№ ${stage.seq}. ${stage.title}`}
                </AppLink>
                <StatusBadge status={stage.status} />
              </div>
              <dl className={list.meta}>
                <dt>Срок подачи</dt>
                <dd className={list.num}>{deadlineText(stage)}</dd>
                <dt>Изменён</dt>
                <dd className={list.num}>{formatDateTime(stage.updatedAt)} МСК</dd>
              </dl>
            </li>
          ))}
        </ul>
      </>
    );
  };

  return (
    <section className={form.stack} aria-label="Этапы тендера">
      {data && data.items.length > 0 && createButton ? <div className={form.actions}>{createButton}</div> : null}
      {renderBody()}
      {creating ? <CreateStageDialog tenderId={tenderId} onClose={() => setCreating(false)} onCreated={onCreated} /> : null}
    </section>
  );
};
