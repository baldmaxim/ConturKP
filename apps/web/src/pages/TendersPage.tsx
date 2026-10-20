import { useState, type FC, type MouseEvent, type ReactNode } from 'react';
import { listTenders } from '../api/endpoints';
import type { ITender } from '../api/types';
import { AppLink } from '../components/AppLink';
import { Button } from '../components/Button';
import { ContextMenu } from '../components/ContextMenu';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import type { TMenuEntry } from '../components/menuTypes';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { useApiResource } from '../hooks/useApiResource';
import { useAppNavigate } from '../hooks/useAppNavigate';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { formatDateTime } from '../utils/datetime';
import type { IPoint } from '../utils/menuAim';
import { MEMBER_ROLE_LABELS } from '../utils/labels';
import list from '../styles/list.module.css';
import { CreateTenderDialog } from './CreateTenderDialog';

const roleText = (tender: ITender): string => (tender.myRole ? MEMBER_ROLE_LABELS[tender.myRole] : 'Не участник');


export const TendersPage: FC = () => {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useAppNavigate();
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ point: IPoint; tender: ITender } | null>(null);
  const { data, error, loading, reload } = useApiResource((signal) => listTenders(signal), 'tenders');
  const canCreate = can('admin.tender');
  const absent = <span className={list.muted}>не указан</span>;

  const onCreated = (tender: ITender): void => {
    setCreating(false);
    toast.push({ kind: 'success', text: `Тендер ${tender.code} создан.` });
    navigate(`/tenders/${tender.id}`);
  };

  const openMenu = (event: MouseEvent<HTMLElement>, tender: ITender): void => {
    event.preventDefault();
    setMenu({ point: { x: event.clientX, y: event.clientY }, tender });
  };

  const copyText = (text: string, done: string): void => {
    if (!navigator.clipboard) {
      toast.push({ kind: 'error', text: 'Буфер обмена недоступен в этом браузере.' });
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => toast.push({ kind: 'success', text: done }),
      () => toast.push({ kind: 'error', text: 'Не удалось скопировать в буфер обмена.' }),
    );
  };

  const tenderMenu = (tender: ITender): TMenuEntry[] => {
    const path = `/tenders/${tender.id}`;
    return [
      { kind: 'action', id: 'open', label: 'Открыть', onSelect: () => navigate(path) },
      { kind: 'action', id: 'open-tab', label: 'Открыть в новой вкладке', onSelect: () => void window.open(path, '_blank', 'noopener') },
      { kind: 'separator', id: 'sep-copy' },
      {
        kind: 'submenu',
        id: 'copy',
        label: 'Копировать',
        entries: [
          { kind: 'action', id: 'copy-code', label: 'Код', onSelect: () => copyText(tender.code, 'Код тендера скопирован.') },
          { kind: 'action', id: 'copy-title', label: 'Название', onSelect: () => copyText(tender.title, 'Название тендера скопировано.') },
          {
            kind: 'action',
            id: 'copy-link',
            label: 'Ссылку',
            onSelect: () => copyText(new URL(path, window.location.origin).href, 'Ссылка на тендер скопирована.'),
          },
        ],
      },
      { kind: 'separator', id: 'sep-reload' },
      { kind: 'action', id: 'reload', label: 'Обновить список', onSelect: reload },
    ];
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
                <tr
                  key={tender.id}
                  className={menu?.tender.id === tender.id ? list.menuTarget : undefined}
                  onContextMenu={(event) => openMenu(event, tender)}
                >
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
      {menu ? (
        <ContextMenu
          key={`${menu.point.x}:${menu.point.y}`}
          point={menu.point}
          entries={tenderMenu(menu.tender)}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {creating ? <CreateTenderDialog onClose={() => setCreating(false)} onCreated={onCreated} /> : null}
    </>
  );
};
