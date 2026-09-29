import { useState, type FC, type ReactNode } from 'react';
import { listContracts } from '../../api/contractEndpoints';
import type { IContract } from '../../api/contractTypes';
import { AppLink } from '../../components/AppLink';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { PageHeader } from '../../components/PageHeader';
import { StatusBadge } from '../../components/StatusBadge';
import { useApiResource } from '../../hooks/useApiResource';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import list from '../../styles/list.module.css';
import { CreateContractDialog } from './CreateContractDialog';

const accessBadge = (contract: IContract): ReactNode =>
  contract.restricted ? <Badge tone="neutral" icon="lock" dashed label="Только карточка" /> : <Badge tone="success" icon="check" label="Чтение" />;

/** Договоры, видимые пользователю: с выдачей по договору или все — для администратора договоров (только карточки). */
export const ContractsPage: FC = () => {
  const toast = useToast();
  const navigate = useAppNavigate();
  const [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useApiResource((signal) => listContracts(signal), 'contracts');
  const canCreate = data?.canCreate ?? false;
  const absent = <span className={list.muted}>скрыто</span>;

  const onCreated = (contract: IContract): void => {
    setCreating(false);
    toast.push({ kind: 'success', text: `Договор ${contract.number} создан.` });
    navigate(`/contracts/${contract.id}`);
  };

  const createButton = canCreate ? (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      Создать договор
    </Button>
  ) : null;

  const renderBody = (): ReactNode => {
    if (loading && !data) return <LoadingState />;
    if (error) return <ErrorState error={error} onRetry={reload} />;
    const items = data?.items ?? [];
    if (items.length === 0) {
      return (
        <EmptyState
          icon="file-signature"
          title="Договоров пока нет"
          text={canCreate ? 'Создайте договор и загрузите его документы.' : 'Здесь появятся договоры, доступ к которым вам выдали.'}
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
                <th scope="col">Номер</th>
                <th scope="col">Предмет</th>
                <th scope="col">Контрагент</th>
                <th scope="col">Доступ</th>
                <th scope="col">Статус</th>
                <th scope="col">Изменён, МСК</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td className={list.mono}>{c.number}</td>
                  <td>
                    <AppLink className={list.rowLink} to={`/contracts/${c.id}`}>
                      {c.title}
                    </AppLink>
                  </td>
                  <td>{c.restricted ? absent : (c.counterparty ?? <span className={list.muted}>не указан</span>)}</td>
                  <td>{accessBadge(c)}</td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className={list.num}>{formatDateTime(c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className={list.cards}>
          {items.map((c) => (
            <li key={c.id} className={list.card}>
              <div className={list.cardHead}>
                <AppLink className={list.rowLink} to={`/contracts/${c.id}`}>
                  {c.title}
                </AppLink>
                <StatusBadge status={c.status} />
              </div>
              <dl className={list.meta}>
                <dt>Номер</dt>
                <dd className={list.mono}>{c.number}</dd>
                <dt>Контрагент</dt>
                <dd>{c.restricted ? absent : (c.counterparty ?? 'не указан')}</dd>
                <dt>Доступ</dt>
                <dd>{accessBadge(c)}</dd>
                <dt>Изменён</dt>
                <dd className={list.num}>{formatDateTime(c.updatedAt)} МСК</dd>
              </dl>
            </li>
          ))}
        </ul>
      </>
    );
  };

  return (
    <>
      <PageHeader title="Договоры" actions={data && data.items.length > 0 ? createButton : null} />
      {renderBody()}
      {creating ? <CreateContractDialog onClose={() => setCreating(false)} onCreated={onCreated} /> : null}
    </>
  );
};
