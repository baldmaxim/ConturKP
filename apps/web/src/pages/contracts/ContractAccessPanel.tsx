import { useState, type FC } from 'react';
import { listContractAccess, putContractAccess } from '../../api/contractEndpoints';
import type { IContract, IContractGrant, TContractCapability } from '../../api/contractTypes';
import { listUsers } from '../../api/endpoints';
import { describeError, hasCode } from '../../api/errors';
import { Badge } from '../../components/Badge';
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
import { ALL_CONTRACT_CAPABILITIES, CONTRACT_CAPABILITY_HINTS, CONTRACT_CAPABILITY_LABELS } from '../../utils/contractLabels';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './Contracts.module.css';

interface IContractAccessPanelProps {
  contract: IContract;
  onContractChanged: () => void;
}

interface IUserGrants {
  userId: string;
  displayName: string;
  login: string;
  capabilities: TContractCapability[];
  creator: boolean;
}

const byUser = (grants: IContractGrant[]): IUserGrants[] => {
  const map = new Map<string, IUserGrants>();
  for (const g of grants) {
    const row = map.get(g.userId) ?? { userId: g.userId, displayName: g.displayName, login: g.login, capabilities: [], creator: false };
    if (g.capability !== 'contract.create') row.capabilities.push(g.capability);
    row.creator ||= g.source === 'creator';
    map.set(g.userId, row);
  }
  return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
};

/**
 * Строки доступа к договору (образец mailbox_access, D-017): ведёт администратор договоров. Выдача действует
 * только у инженера или руководителя; сама возможность admin.contract содержимого договора не открывает.
 */
export const ContractAccessPanel: FC<IContractAccessPanelProps> = ({ contract, onContractChanged }) => {
  const toast = useToast();
  const grantsRes = useApiResource((signal) => listContractAccess(contract.id, signal), contract.id);
  const usersRes = useApiResource((signal) => listUsers(signal), 'contract-access-users');
  const [editing, setEditing] = useState<{ userId: string; capabilities: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = byUser(grantsRes.data?.items ?? []);
  const eligible = (usersRes.data?.items ?? []).filter((u) => u.status === 'active' && (u.roles.includes('engineer') || u.roles.includes('manager')));

  const save = async (): Promise<void> => {
    if (!editing?.userId) {
      setError('Выберите пользователя.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const version = grantsRes.data?.contractRowVersion ?? contract.rowVersion;
      await putContractAccess(contract.id, version, editing.userId, editing.capabilities as TContractCapability[]);
      toast.push({ kind: 'success', text: 'Доступ к договору сохранён.' });
      setEditing(null);
      grantsRes.reload();
      onContractChanged();
    } catch (e) {
      setError(hasCode(e, 'VERSION_CONFLICT') ? 'Договор изменён другим пользователем — перечитайте доступ и повторите.' : describeError(e));
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
        <p className={list.muted}>Администратор договоров ведёт строки доступа, но содержимое договора ему не открывается.</p>
        <Button variant="primary" icon="user-plus" onClick={() => setEditing({ userId: '', capabilities: ['contract.read'] })}>
          Выдать доступ
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="key-round" title="Доступа пока ни у кого нет" text="Выдайте чтение, связь или ведение конкретным пользователям." />
      ) : (
        <ul className={styles.cards}>
          {rows.map((r) => (
            <li key={r.userId} className={list.card}>
              <div className={list.cardHead}>
                <span className={list.cardTitle}>{r.displayName}</span>
                {r.creator ? <Badge tone="info" icon="file-signature" label="Создатель" /> : null}
              </div>
              <p className={list.mono}>{r.login}</p>
              <p>{r.capabilities.map((c) => CONTRACT_CAPABILITY_LABELS[c]).join(' · ') || 'нет'}</p>
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
          title="Доступ к договору"
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
            onValueChange={(userId) => setEditing({ userId, capabilities: rows.find((r) => r.userId === userId)?.capabilities ?? ['contract.read'] })}
            hint="Только активные инженеры и руководители: у других выдача не действует."
            required
          />
          <CheckboxGroup
            legend="Права по договору"
            options={ALL_CONTRACT_CAPABILITIES.map((c) => ({ value: c, label: CONTRACT_CAPABILITY_LABELS[c] }))}
            selected={editing.capabilities}
            onChange={(capabilities) => setEditing({ ...editing, capabilities })}
            hint={`${ALL_CONTRACT_CAPABILITIES.map((c) => CONTRACT_CAPABILITY_HINTS[c]).join(' ')} Снимите все отметки, чтобы отозвать доступ.`}
          />
        </Dialog>
      ) : null}
    </div>
  );
};
