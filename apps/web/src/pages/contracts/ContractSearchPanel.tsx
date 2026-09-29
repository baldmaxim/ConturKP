import { useState, type FC, type FormEvent } from 'react';
import { runContractSearch } from '../../api/contractEndpoints';
import { describeError, stateConflictCurrent } from '../../api/errors';
import { getSearchRun } from '../../api/searchEndpoints';
import type { ISearchRun } from '../../api/types';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { TextField } from '../../components/TextField';
import { usePolling } from '../../hooks/usePolling';
import form from '../../styles/form.module.css';
import { SearchRunView } from '../search/SearchRunView';
import styles from '../search/SearchTab.module.css';

interface IContractSearchPanelProps {
  contractId: string;
}

/**
 * Поиск в контексте договора (ADR-012 §24): текущий корпус — последняя редакция основного договора,
 * допсоглашений и приложений. Документы тендеров сюда не попадают, даже при связи договора с тендером.
 */
export const ContractSearchPanel: FC<IContractSearchPanelProps> = ({ contractId }) => {
  const [query, setQuery] = useState('');
  const [run, setRun] = useState<ISearchRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  usePolling(run?.status === 'pending', () => {
    if (!run) return;
    getSearchRun(run.searchRunId).then(
      (next) => setRun((prev) => (prev?.searchRunId === next.searchRunId ? next : prev)),
      (e: unknown) => setError(e),
    );
  }, 1500);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    runContractSearch(contractId, text).then(
      (result) => {
        setRun(result);
        setBusy(false);
      },
      (e: unknown) => {
        setError(e);
        setRun(null);
        setBusy(false);
      },
    );
  };

  const current = stateConflictCurrent(error);
  const notReady = current !== null && typeof current === 'object' && 'reason' in current && (current as { reason: unknown }).reason === 'search_index_not_ready';

  return (
    <div className={form.stack}>
      <form className={styles.form} onSubmit={submit} role="search" aria-label="Поиск по договору">
        <TextField label="Запрос" value={query} onValueChange={setQuery} placeholder="Например: аванс, удержание, неустойка" required maxLength={500} />
        <div className={form.actions}>
          <Button type="submit" variant="primary" icon="search" loading={busy} disabled={!query.trim()}>
            Найти в договоре
          </Button>
        </div>
      </form>
      {notReady ? <Notice tone="info">Индекс поиска ещё строится. Повторите запрос через минуту.</Notice> : null}
      {error && !notReady ? <Notice tone="danger">{describeError(error)}</Notice> : null}
      {run ? <SearchRunView run={run} /> : null}
    </div>
  );
};
