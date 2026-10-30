import { useState, type FC, type MouseEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listTenders, updateTender } from '../api/endpoints';
import { describeError } from '../api/errors';
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
import { Tabs, tabId, tabPanelId } from '../components/Tabs';
import { useApiResource } from '../hooks/useApiResource';
import { useAppNavigate } from '../hooks/useAppNavigate';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { formatDateTime } from '../utils/datetime';
import type { IPoint } from '../utils/menuAim';
import { MEMBER_ROLE_LABELS } from '../utils/labels';
import list from '../styles/list.module.css';
import { CreateTenderDialog } from './CreateTenderDialog';
import { TenderArchiveDialog } from './TenderArchiveDialog';

const roleText = (tender: ITender): string => (tender.myRole ? MEMBER_ROLE_LABELS[tender.myRole] : tender.capabilities.includes('tender.read') ? 'Доступ на чтение' : 'Не участник');


export const TendersPage: FC = () => {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('status') === 'archived' ? 'archived' : 'active';
  const [archiving, setArchiving] = useState<ITender | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ point: IPoint; tender: ITender } | null>(null);
  const { data, error, loading, reload } = useApiResource((signal) => listTenders(signal), 'tenders');
  const canCreate = can('admin.tender');
  const counts = { active: data?.items.filter((t) => t.status === 'active').length ?? 0, archived: data?.items.filter((t) => t.status === 'archived').length ?? 0 };
  const selectView = (id: string): void => {
    setMenu(null);
    setSearchParams((prev) => { const next = new URLSearchParams(prev); if (id === 'archived') next.set('status', 'archived'); else next.delete('status'); return next; });
  };
  const restore = async (tender: ITender): Promise<void> => {
    if (restoring) return;
    setRestoring(tender.id);
    try {
      await updateTender(tender.id, tender.rowVersion, { status: 'active', outcome: null });
      toast.push({ kind: 'success', text: 'Тендер возвращён в действующие.' });
      reload();
    } catch (reason) { toast.push({ kind: 'error', text: describeError(reason) }); reload(); }
    finally { setRestoring(null); }
  };
  const archiveAction = (tender: ITender): ReactNode => tender.capabilities.includes('admin.tender') ? (
    <Button icon={tender.status === 'active' ? 'archive' : 'undo-2'} loading={restoring === tender.id} disabled={restoring !== null} onClick={() => tender.status === 'active' ? setArchiving(tender) : void restore(tender)}>
      {tender.status === 'active' ? 'В архив' : 'Вернуть'}
    </Button>
  ) : null;
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
      ...(tender.capabilities.includes('admin.tender') ? [
        { kind: 'separator' as const, id: 'sep-archive' },
        { kind: 'action' as const, id: 'archive', label: tender.status === 'active' ? 'В архив…' : 'Вернуть в действующие', onSelect: () => tender.status === 'active' ? setArchiving(tender) : void restore(tender) },
      ] : []),
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
    const items = data?.items.filter((tender) => tender.status === view) ?? [];
    const canArchive = items.some((tender) => tender.capabilities.includes('admin.tender'));
    if (items.length === 0 && (view === 'archived' || (data?.items.length ?? 0) > 0)) {
      return <EmptyState icon={view === 'archived' ? 'archive' : 'inbox'} title={view === 'archived' ? 'Архив пуст' : 'Действующих тендеров нет'} text={view === 'archived' ? 'Здесь сохраняются выигранные и проигранные тендеры.' : 'Завершённые тендеры доступны на вкладке «Архивные».'} />;
    }
    if (items.length === 0) {
      return canCreate || can('tender.read.all') ? (
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
                {canArchive ? <th scope="col">Действия</th> : null}
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
                    <StatusBadge status={tender.status} outcome={tender.outcome} />
                  </td>
                  <td className={list.num}>{formatDateTime(tender.updatedAt)}</td>
                  {canArchive ? <td>{archiveAction(tender)}</td> : null}
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
                <StatusBadge status={tender.status} outcome={tender.outcome} />
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
              {archiveAction(tender)}
            </li>
          ))}
        </ul>
      </>
    );
  };

  return (
    <>
      <PageHeader title="Тендеры" actions={data && data.items.length > 0 ? createButton : null} />
      <Tabs tabs={[
        { id: 'active', label: 'Действующие' + (data ? ' · ' + counts.active : ''), icon: 'briefcase' },
        { id: 'archived', label: 'Архивные' + (data ? ' · ' + counts.archived : ''), icon: 'archive' },
      ]} active={view} onChange={selectView} label="Список тендеров" />
      <div role="tabpanel" id={tabPanelId(view)} aria-labelledby={tabId(view)}>{renderBody()}</div>
      {archiving ? <TenderArchiveDialog tender={archiving} onClose={() => { setArchiving(null); reload(); }} onSaved={() => { setArchiving(null); reload(); toast.push({ kind: 'success', text: 'Тендер перенесён в архив.' }); }} /> : null}
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
