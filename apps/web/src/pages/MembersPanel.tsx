import { useState, type FC, type ReactNode } from 'react';
import { deleteMember, listMembers, listUsers, putMember } from '../api/endpoints';
import { describeError, hasCode } from '../api/errors';
import type { IMember, IMembersResponse, TMemberRole } from '../api/types';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { Notice } from '../components/Notice';
import { SelectField } from '../components/SelectField';
import { useApiResource } from '../hooks/useApiResource';
import { useToast } from '../hooks/useToast';
import { formatDateTime } from '../utils/datetime';
import { MEMBER_ROLE_LABELS, globalRoleLabel } from '../utils/labels';
import form from '../styles/form.module.css';
import list from '../styles/list.module.css';

interface IMembersPanelProps {
  tenderId: string;
  /** 'admin.tender' в тендере: назначение и снятие участников. */
  canAdmin: boolean;
  /** Глобальная 'admin.users': список пользователей для выбора. */
  canListUsers: boolean;
  onTenderChanged: () => void;
}

export const MembersPanel: FC<IMembersPanelProps> = ({ tenderId, canAdmin, canListUsers, onTenderChanged }) => {
  const toast = useToast();
  const members = useApiResource((signal) => listMembers(tenderId, signal), tenderId);
  const users = useApiResource(
    (signal) => (canAdmin && canListUsers ? listUsers(signal) : Promise.resolve(null)),
    `${canAdmin && canListUsers}`,
  );
  const [userId, setUserId] = useState('');
  const [memberRole, setMemberRole] = useState<TMemberRole>('engineer');
  const [assigning, setAssigning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<IMember | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const applyResponse = (response: IMembersResponse): void => {
    members.setData(response);
    onTenderChanged();
  };

  const handleMutationError = (error: unknown): void => {
    if (hasCode(error, 'VERSION_CONFLICT')) {
      setActionError('Состав участников или тендер изменил другой пользователь. Список обновлён — проверьте и повторите.');
      members.reload();
      onTenderChanged();
      return;
    }
    setActionError(describeError(error));
  };

  const assign = async (): Promise<void> => {
    const current = members.data;
    if (!current || !userId) {
      setActionError('Выберите пользователя.');
      return;
    }
    setAssigning(true);
    setActionError(null);
    try {
      const response = await putMember(tenderId, current.tenderRowVersion, userId, memberRole);
      applyResponse(response);
      setUserId('');
      toast.push({ kind: 'success', text: 'Участник назначен.' });
    } catch (error) {
      handleMutationError(error);
    } finally {
      setAssigning(false);
    }
  };

  const remove = async (): Promise<void> => {
    const current = members.data;
    if (!current || !removing) {
      return;
    }
    setRemoveBusy(true);
    setActionError(null);
    try {
      const response = await deleteMember(tenderId, current.tenderRowVersion, removing.userId);
      applyResponse(response);
      toast.push({ kind: 'success', text: `${removing.displayName} снят(а) с тендера.` });
    } catch (error) {
      handleMutationError(error);
    } finally {
      setRemoveBusy(false);
      setRemoving(null);
    }
  };

  const assignedText = (member: IMember): string =>
    `${formatDateTime(member.assignedAt)} МСК${member.assignedBy ? `, ${member.assignedBy.displayName}` : ''}`;

  const userOptions = (users.data?.items ?? [])
    .filter((user) => user.status === 'active')
    .map((user) => ({
      value: user.id,
      label: `${user.displayName} (${user.login}) — ${user.roles.map(globalRoleLabel).join(', ') || 'без ролей'}`,
    }));

  const renderAssignForm = (): ReactNode => {
    if (!canAdmin) {
      return null;
    }
    if (!canListUsers) {
      return <Notice tone="info">Для назначения участников нужно право на просмотр пользователей портала.</Notice>;
    }
    return (
      <form
        className={form.section}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void assign();
        }}
      >
        <h2 className={form.sectionTitle}>Назначить участника</h2>
        {users.error ? <ErrorState error={users.error} onRetry={users.reload} /> : null}
        <div className={form.grid}>
          <SelectField
            label="Пользователь"
            value={userId}
            placeholder={users.loading ? 'Загрузка…' : 'Выберите пользователя'}
            options={userOptions}
            onValueChange={setUserId}
            required
          />
          <SelectField
            label="Роль в тендере"
            value={memberRole}
            options={[
              { value: 'engineer', label: MEMBER_ROLE_LABELS.engineer },
              { value: 'manager', label: MEMBER_ROLE_LABELS.manager },
            ]}
            onValueChange={(value) => setMemberRole(value === 'manager' ? 'manager' : 'engineer')}
            hint="Инженеров в тендере не больше двух. Роль в тендере должна соответствовать роли пользователя в портале."
          />
        </div>
        <div className={form.actions}>
          <Button variant="primary" type="submit" icon="user-plus" loading={assigning} disabled={!members.data}>
            Назначить
          </Button>
        </div>
      </form>
    );
  };

  const renderList = (): ReactNode => {
    if (members.loading && !members.data) {
      return <LoadingState />;
    }
    if (members.error) {
      return <ErrorState error={members.error} onRetry={members.reload} />;
    }
    const items = members.data?.items ?? [];
    if (items.length === 0) {
      return (
        <EmptyState
          icon="users"
          title="Участников пока нет"
          text={canAdmin ? 'Назначьте руководителя и инженеров тендера.' : 'Участников назначает администратор портала.'}
        />
      );
    }
    const removeButton = (member: IMember): ReactNode =>
      canAdmin ? (
        <Button variant="danger" icon="user-minus" onClick={() => setRemoving(member)}>
          Снять
        </Button>
      ) : null;
    return (
      <>
        <div className={list.tableWrap}>
          <table className={list.table}>
            <thead>
              <tr>
                <th scope="col">Участник</th>
                <th scope="col">Логин</th>
                <th scope="col">Роль в тендере</th>
                <th scope="col">Назначен</th>
                {canAdmin ? (
                  <th scope="col">
                    <span className="visually-hidden">Действия</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {items.map((member) => (
                <tr key={member.userId}>
                  <td>{member.displayName}</td>
                  <td className={list.mono}>{member.login}</td>
                  <td>{MEMBER_ROLE_LABELS[member.memberRole]}</td>
                  <td className={list.num}>{assignedText(member)}</td>
                  {canAdmin ? (
                    <td>
                      <div className={list.rowActions}>{removeButton(member)}</div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className={list.cards}>
          {items.map((member) => (
            <li key={member.userId} className={list.card}>
              <div className={list.cardHead}>
                <span className={list.cardTitle}>{member.displayName}</span>
              </div>
              <dl className={list.meta}>
                <dt>Логин</dt>
                <dd className={list.mono}>{member.login}</dd>
                <dt>Роль</dt>
                <dd>{MEMBER_ROLE_LABELS[member.memberRole]}</dd>
                <dt>Назначен</dt>
                <dd className={list.num}>{assignedText(member)}</dd>
              </dl>
              {canAdmin ? <div className={list.rowActions}>{removeButton(member)}</div> : null}
            </li>
          ))}
        </ul>
      </>
    );
  };

  return (
    <section className={form.stack} aria-label="Участники тендера">
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
      {renderAssignForm()}
      {renderList()}
      {removing ? (
        <ConfirmDialog
          title="Снять участника с тендера?"
          confirmLabel={`Снять ${removing.displayName}`}
          confirmIcon="user-minus"
          danger
          busy={removeBusy}
          onConfirm={() => void remove()}
          onClose={() => setRemoving(null)}
        >
          <p>
            {removing.displayName} ({MEMBER_ROLE_LABELS[removing.memberRole].toLowerCase()}) потеряет доступ к этапам и
            материалам этого тендера.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
};
