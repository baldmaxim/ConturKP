import { useState, type FC, type ReactNode } from 'react';
import { listUsers } from '../api/endpoints';
import type { IUser } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { useApiResource } from '../hooks/useApiResource';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { formatDateTime } from '../utils/datetime';
import { globalRoleLabel } from '../utils/labels';
import form from '../styles/form.module.css';
import list from '../styles/list.module.css';
import { ResetPasswordDialog } from './ResetPasswordDialog';
import { UserCreateDialog } from './UserCreateDialog';
import { UserEditDialog } from './UserEditDialog';

type TDialog = { kind: 'create' } | { kind: 'edit'; user: IUser } | { kind: 'password'; user: IUser } | null;

export const UsersPanel: FC = () => {
  const toast = useToast();
  const { me, refresh } = useAuth();
  const { data, error, loading, reload, setData } = useApiResource((signal) => listUsers(signal), 'admin-users');
  const [dialog, setDialog] = useState<TDialog>(null);

  const replaceUser = (user: IUser): void => {
    setData((prev) => (prev ? { items: prev.items.map((item) => (item.id === user.id ? user : item)) } : prev));
  };

  const onCreated = (user: IUser): void => {
    setDialog(null);
    setData((prev) => (prev ? { items: [...prev.items, user] } : { items: [user] }));
    toast.push({ kind: 'success', text: `Пользователь ${user.login} создан.` });
  };

  const onUpdated = (user: IUser): void => {
    setDialog(null);
    replaceUser(user);
    toast.push({ kind: 'success', text: `Изменения пользователя ${user.login} сохранены.` });
    if (user.id === me?.id) {
      void refresh();
    }
  };

  const onPasswordReset = (user: IUser): void => {
    setDialog(null);
    replaceUser(user);
    toast.push({ kind: 'success', text: `Пароль пользователя ${user.login} заменён.` });
  };

  const statusBadge = (user: IUser): ReactNode =>
    user.status === 'active' ? (
      <Badge tone="neutral" icon="circle-dot" label="Активен" />
    ) : (
      <Badge tone="muted" icon="user-x" label="Отключён" />
    );

  const rolesText = (user: IUser): string => user.roles.map(globalRoleLabel).join(', ') || 'без ролей';

  const actions = (user: IUser): ReactNode => (
    <div className={list.rowActions}>
      <Button icon="pencil" onClick={() => setDialog({ kind: 'edit', user })}>
        Изменить
      </Button>
      <Button icon="key-round" onClick={() => setDialog({ kind: 'password', user })}>
        Сбросить пароль
      </Button>
    </div>
  );

  const renderBody = (): ReactNode => {
    if (loading && !data) {
      return <LoadingState />;
    }
    if (error) {
      return <ErrorState error={error} onRetry={reload} />;
    }
    const items = [...(data?.items ?? [])].sort((a, b) => a.login.localeCompare(b.login, 'ru'));
    if (items.length === 0) {
      return <EmptyState icon="users" title="Пользователей нет" text="Создайте первую учётную запись." />;
    }
    return (
      <>
        <div className={list.tableWrap}>
          <table className={list.table}>
            <thead>
              <tr>
                <th scope="col">Логин</th>
                <th scope="col">Имя</th>
                <th scope="col">Роли</th>
                <th scope="col">Статус</th>
                <th scope="col">Создан, МСК</th>
                <th scope="col">
                  <span className="visually-hidden">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((user) => (
                <tr key={user.id}>
                  <td className={list.mono}>{user.login}</td>
                  <td>{user.displayName}</td>
                  <td>{rolesText(user)}</td>
                  <td>{statusBadge(user)}</td>
                  <td className={list.num}>{formatDateTime(user.createdAt)}</td>
                  <td>{actions(user)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className={list.cards}>
          {items.map((user) => (
            <li key={user.id} className={list.card}>
              <div className={list.cardHead}>
                <span className={list.cardTitle}>{user.displayName}</span>
                {statusBadge(user)}
              </div>
              <dl className={list.meta}>
                <dt>Логин</dt>
                <dd className={list.mono}>{user.login}</dd>
                <dt>Роли</dt>
                <dd>{rolesText(user)}</dd>
                <dt>Создан</dt>
                <dd className={list.num}>{formatDateTime(user.createdAt)} МСК</dd>
              </dl>
              {actions(user)}
            </li>
          ))}
        </ul>
      </>
    );
  };

  return (
    <section className={form.stack} aria-label="Пользователи портала">
      <div className={form.actions}>
        <Button variant="primary" icon="user-plus" onClick={() => setDialog({ kind: 'create' })}>
          Создать пользователя
        </Button>
      </div>
      {renderBody()}
      {dialog?.kind === 'create' ? <UserCreateDialog onClose={() => setDialog(null)} onCreated={onCreated} /> : null}
      {dialog?.kind === 'edit' ? (
        <UserEditDialog
          user={dialog.user}
          isSelf={dialog.user.id === me?.id}
          onClose={() => setDialog(null)}
          onSaved={onUpdated}
          onReloaded={replaceUser}
        />
      ) : null}
      {dialog?.kind === 'password' ? (
        <ResetPasswordDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onDone={onPasswordReset}
          onReloaded={replaceUser}
        />
      ) : null}
    </section>
  );
};
