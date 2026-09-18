import { useState, type FC, type ReactNode } from 'react';
import { listTenders } from '../api/endpoints';
import type { ITender } from '../api/types';
import { AppLink } from '../components/AppLink';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { useApiResource } from '../hooks/useApiResource';
import { useAppNavigate } from '../hooks/useAppNavigate';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { formatDateTime } from '../utils/datetime';
import { MEMBER_ROLE_LABELS } from '../utils/labels';
import list from '../styles/list.module.css';
import { CreateTenderDialog } from './CreateTenderDialog';

const roleText = (tender: ITender): string => (tender.myRole ? MEMBER_ROLE_LABELS[tender.myRole] : 'Не участник');


export const TendersPage: FC = () => {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useAppNavigate();
  const [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useApiResource((signal) => listTenders(signal), 'tenders');
  const canCreate = can('admin.tender');
  const absent = <span className={list.muted}>не указан</span>;

  const onCreated = (tender: ITender): void => {
    setCreating(false);
    toast.push({ kind: 'success', text: `Тендер ${tender.code} создан.` });
    navigate(`/tenders/${tender.id}`);
  };

  const createButton = canCreate ? (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      Создать тендер
    </Button>
  ) : null;

  const renderBody = (): ReactNode => {
    if (loading && !data) {
      return <LoadingState />;
    }
    if (error) {
      return <ErrorState error={error} onRetry={reload} />;
    }
    const items = data?.items ?? [];
    if (items.length === 0) {
      return canCreate ? (
        <EmptyState
          icon="inbox"
          title="Тендеров пока нет"
          text="В портале ещё не создано ни одного тендера."
          action={createButton}
        />
      ) : (
        <EmptyState
          icon="inbox"
          title="Вас пока не назначили в тендеры"
          text="Здесь появятся тендеры, в которых вы участник. Назначает администратор портала."
        />
      );
    }
    return (
      <>
        <div className={list.tableWrap}>
          <table className={list.table}>
            <thead>
              <tr>
                <th scope="col">Код</th>
                <th scope="col">Название</th>
                <th scope="col">Заказчик</th>
                <th scope="col">Объект</th>
                <th scope="col">Моя роль</th>
                <th scope="col">Статус</th>
                <th scope="col">Изменён, МСК</th>
              </tr>
            </thead>
            <tbody>
              {items.map((tender) => (
                <tr key={tender.id}>
                  <td className={list.mono}>{tender.code}</td>
                  <td>
                    <AppLink className={list.rowLink} to={`/tenders/${tender.id}`}>
                      {tender.title}
                    </AppLink>
                  </td>
                  <td>{tender.customerName ?? absent}</td>
                  <td>{tender.objectName ?? absent}</td>
                  <td>{roleText(tender)}</td>
                  <td>
                    <StatusBadge status={tender.status} />
                  </td>
                  <td className={list.num}>{formatDateTime(tender.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className={list.cards}>
          {items.map((tender) => (
            <li key={tender.id} className={list.card}>
              <div className={list.cardHead}>
                <AppLink className={list.rowLink} to={`/tenders/${tender.id}`}>
                  {tender.title}
                </AppLink>
                <StatusBadge status={tender.status} />
              </div>
              <dl className={list.meta}>
                <dt>Код</dt>
                <dd className={list.mono}>{tender.code}</dd>
                <dt>Заказчик</dt>
                <dd>{tender.customerName ?? absent}</dd>
                <dt>Объект</dt>
                <dd>{tender.objectName ?? absent}</dd>
                <dt>Моя роль</dt>
                <dd>{roleText(tender)}</dd>
                <dt>Изменён</dt>
                <dd className={list.num}>{formatDateTime(tender.updatedAt)} МСК</dd>
              </dl>
            </li>
          ))}
        </ul>
      </>
    );
  };

  return (
    <>
      <PageHeader title="Тендеры" actions={data && data.items.length > 0 ? createButton : null} />
      {renderBody()}
      {creating ? <CreateTenderDialog onClose={() => setCreating(false)} onCreated={onCreated} /> : null}
    </>
  );
};
