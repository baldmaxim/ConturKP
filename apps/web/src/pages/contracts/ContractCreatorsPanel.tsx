import { useState, type FC } from 'react';
import { listContractCreators, setContractCreator } from '../../api/contractEndpoints';
import { listUsers } from '../../api/endpoints';
import { describeError } from '../../api/errors';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from './Contracts.module.css';

/**
 * Кто может создавать договоры (contract.create, D-022 OD-2): явная выдача администратором договоров.
 * Создатель получает чтение и ведение своего договора; выдача действует у инженера или руководителя.
 */
export const ContractCreatorsPanel: FC = () => {
  const toast = useToast();
  const creators = useApiResource((signal) => listContractCreators(signal), 'contract-creators');
  const users = useApiResource((signal) => listUsers(signal), 'contract-creators-users');
  const [busy, setBusy] = useState<string | null>(null);
  const granted = new Map((creators.data?.items ?? []).map((g) => [g.userId, g]));
  const eligible = (users.data?.items ?? []).filter((u) => u.status === 'active' && (u.roles.includes('engineer') || u.roles.includes('manager')));

  const toggle = async (userId: string, grant: boolean): Promise<void> => {
    setBusy(userId);
    try {
      await setContractCreator(userId, grant);
      toast.push({ kind: 'success', text: grant ? 'Право создавать договоры выдано.' : 'Право создавать договоры отозвано.' });
      creators.reload();
    } catch (e) {
      toast.push({ kind: 'error', text: describeError(e) });
    } finally {
      setBusy(null);
    }
  };

  if ((creators.loading && !creators.data) || (users.loading && !users.data)) return <LoadingState />;
  if (creators.error) return <ErrorState error={creators.error} onRetry={creators.reload} />;
  if (users.error) return <ErrorState error={users.error} onRetry={users.reload} />;

  return (
    <div className={form.stack}>
      <p className={list.muted}>Создатель договора получает чтение и ведение своего договора. Права по чужим договорам выдаются на странице договора.</p>
      <ul className={styles.cards}>
        {eligible.map((u) => {
          const g = granted.get(u.id);
          return (
            <li key={u.id} className={list.card}>
              <div className={list.cardHead}>
                <span className={list.cardTitle}>{u.displayName}</span>
                {g ? <Badge tone="success" icon="check" label="Создаёт договоры" /> : <Badge tone="neutral" icon="lock" dashed label="Не создаёт" />}
              </div>
              <p className={list.mono}>{u.login}</p>
              {g ? <p className={list.muted}>{`Выдал ${g.grantedBy.displayName}, ${formatDateTime(g.grantedAt)} МСК`}</p> : null}
              <div className={styles.actions}>
                <Button icon={g ? 'user-minus' : 'user-plus'} loading={busy === u.id} onClick={() => void toggle(u.id, !g)}>
                  {g ? 'Отозвать' : 'Разрешить создавать договоры'}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
