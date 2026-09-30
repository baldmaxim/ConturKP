import { useState, type FC } from 'react';
import { listUsers } from '../../api/endpoints';
import { describeError, hasCode } from '../../api/errors';
import { listMailAccess, putMailAccess } from '../../api/mailEndpoints';
import type { IMailbox, TMailCapability } from '../../api/mailTypes';
import { Button } from '../../components/Button';
import { CheckboxGroup } from '../../components/CheckboxGroup';
import { Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import { ALL_MAIL_CAPABILITIES, MAIL_CAPABILITY_HINTS, MAIL_CAPABILITY_LABELS } from '../../utils/mailLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './Mail.module.css';

interface IMailboxAccessPanelProps {
  mailbox: IMailbox;
  onMailboxChanged: () => void;
}

/**
 * Выдачи по ящику (OD-07-3, образец contract_access): ведёт администратор ящиков. Выдача действует только
 * у инженера или руководителя; связь письма с тендером доступа к письму не даёт.
 */
export const MailboxAccessPanel: FC<IMailboxAccessPanelProps> = ({ mailbox, onMailboxChanged }) => {
  const toast = useToast();
  const grantsRes = useApiResource((signal) => listMailAccess(mailbox.id, signal), `access:${mailbox.id}`);
  const usersRes = useApiResource((signal) => listUsers(signal), 'mail-access-users');
  const [editing, setEditing] = useState<{ userId: string; capabilities: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = grantsRes.data?.items ?? [];
  const eligible = (usersRes.data?.items ?? []).filter((u) => u.status === 'active' && (u.roles.includes('engineer') || u.roles.includes('manager')));

  const save = async (): Promise<void> => {
    if (!editing?.userId) {
      setError('Выберите пользователя.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const version = grantsRes.data?.mailboxRowVersion ?? mailbox.rowVersion;
      await putMailAccess(mailbox.id, version, editing.userId, editing.capabilities as TMailCapability[]);
      toast.push({ kind: 'success', text: 'Доступ к ящику сохранён.' });
      setEditing(null);
      grantsRes.reload();
      onMailboxChanged();
    } catch (e) {
      setError(hasCode(e, 'VERSION_CONFLICT') ? 'Ящик изменён другим пользователем — перечитайте доступ и повторите.' : describeError(e));
      if (hasCode(e, 'VERSION_CONFLICT')) grantsRes.reload();
    } finally {
      setSaving(false);
    }
  };

  if (grantsRes.loading && !grantsRes.data) return <LoadingState />;
  if (grantsRes.error) return <ErrorState error={grantsRes.error} onRetry={grantsRes.reload} />;

  return (
    <div className={form.stack}>
      <div className={form.sectionHead}>
        <p className={list.muted}>Администратор ящиков ведёт выдачи, но письма ему не открываются без собственной выдачи «Чтение писем».</p>
        <Button variant="primary" icon="user-plus" onClick={() => setEditing({ userId: '', capabilities: ['mail.read'] })}>
          Выдать доступ
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="key-round" title="Доступа пока ни у кого нет" text="Выдайте чтение, импорт или связь конкретным пользователям." />
      ) : (
        <ul className={styles.cards}>
          {rows.map((r) => (
            <li key={r.userId} className={list.card}>
              <div className={list.cardHead}>
                <span className={list.cardTitle}>{r.displayName}</span>
              </div>
              <p className={list.mono}>{r.login}</p>
              <p>{ALL_MAIL_CAPABILITIES.filter((c) => r.capabilities.includes(c)).map((c) => MAIL_CAPABILITY_LABELS[c]).join(' · ') || 'нет'}</p>
              <div className={styles.actions}>
                <Button icon="pencil" onClick={() => setEditing({ userId: r.userId, capabilities: r.capabilities })}>
                  Изменить
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <Dialog
          title="Доступ к ящику"
          onClose={() => setEditing(null)}
          busy={saving}
          onSubmit={() => void save()}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
                Отмена
              </Button>
              <Button variant="primary" type="submit" icon="check" loading={saving}>
                Сохранить
              </Button>
            </>
          }
        >
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <SelectField
            label="Пользователь"
            value={editing.userId}
            placeholder="Выберите пользователя"
            options={eligible.map((u) => ({ value: u.id, label: `${u.displayName} (${u.login})` }))}
            onValueChange={(userId) => setEditing({ userId, capabilities: rows.find((r) => r.userId === userId)?.capabilities ?? ['mail.read'] })}
            hint="Только активные инженеры и руководители: у других выдача не действует."
            required
          />
          <CheckboxGroup
            legend="Права по ящику"
            options={ALL_MAIL_CAPABILITIES.map((c) => ({ value: c, label: MAIL_CAPABILITY_LABELS[c] }))}
            selected={editing.capabilities}
            onChange={(capabilities) => setEditing({ ...editing, capabilities })}
            hint={`${ALL_MAIL_CAPABILITIES.map((c) => MAIL_CAPABILITY_HINTS[c]).join(' ')} Снимите все отметки, чтобы отозвать доступ.`}
          />
        </Dialog>
      ) : null}
    </div>
  );
};
