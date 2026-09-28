import { useState, type FC, type FormEvent } from 'react';
import { describeError, stateConflictCurrent } from '../../api/errors';
import { createEvidenceScope, getSearchRun, listEvidenceScopes, runSearch } from '../../api/searchEndpoints';
import type { ISearchRun } from '../../api/types';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { Notice } from '../../components/Notice';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useApiResource } from '../../hooks/useApiResource';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/datetime';
import form from '../../styles/form.module.css';
import { SearchRunView } from './SearchRunView';
import styles from './SearchTab.module.css';

interface ISearchTabProps {
  tenderId: string;
  stageId: string;
  canWrite: boolean;
}

const WORKING = 'working';

const reasonOf = (error: unknown): string | null => {
  const current = stateConflictCurrent(error);
  return current && typeof current === 'object' && 'reason' in current ? String((current as { reason: unknown }).reason) : null;
};

/**
 * Поиск по области этапа (ADR-008, ADR-012): рабочий состав или сохранённый снимок области.
 * Область строит сервер; клиент выбирает только этап или снимок.
 */
export const SearchTab: FC<ISearchTabProps> = ({ tenderId, stageId, canWrite }) => {
  const toast = useToast();
  const scopes = useApiResource((signal) => listEvidenceScopes(stageId, signal), stageId);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState(WORKING);
  const [run, setRun] = useState<ISearchRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(false);
  const idem = useIdempotencyKey();

  // Прогон ждёт смысловую ветку — перечитывается, пока не станет терминальным.
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
    const choice = scope === WORKING ? { mode: 'working' as const, stageId } : { mode: 'review' as const, evidenceScopeId: scope };
    runSearch(tenderId, choice, text).then(
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

  const fixScope = (): void => {
    setFixing(true);
    createEvidenceScope(stageId, idem.keyFor({ stageId })).then(
      (created) => {
        idem.reset();
        setFixing(false);
        toast.push({ kind: 'success', text: created.reused ? 'Состав не изменился — выбран прежний снимок.' : 'Снимок области зафиксирован.' });
        scopes.reload();
        setScope(created.id);
      },
      (e: unknown) => {
        setFixing(false);
        toast.push({ kind: 'error', text: `Снимок не зафиксирован: ${describeError(e)}` });
      },
    );
  };

  const options = [
    { value: WORKING, label: 'Рабочий состав этапа' },
    ...(scopes.data?.items ?? []).map((s) => ({ value: s.id, label: `Снимок от ${formatDateTime(s.createdAt)} · ${s.units ?? 0} ед.` })),
  ];
  const notReady = reasonOf(error) === 'search_index_not_ready';

  return (
    <div className={form.stack}>
      <form className={styles.form} onSubmit={submit} role="search" aria-label="Поиск по доказательствам этапа">
        <TextField label="Запрос" value={query} onValueChange={setQuery} placeholder="Например: гарантийный срок или АР-01" required maxLength={500} />
        <SelectField label="Область" value={scope} options={options} onValueChange={setScope} hint="Снимок области — исторический состав: поздние документы и прогоны в него не входят." />
        <div className={form.actions}>
          <Button type="submit" variant="primary" icon="search" loading={busy} disabled={!query.trim()}>
            Найти
          </Button>
          {canWrite ? (
            <Button icon="archive" loading={fixing} onClick={fixScope}>
              Зафиксировать снимок области
            </Button>
          ) : null}
        </div>
      </form>
      {scopes.error ? <ErrorState error={scopes.error} onRetry={scopes.reload} /> : null}
      {notReady ? <Notice tone="info">Индекс поиска ещё строится. Повторите запрос через минуту.</Notice> : null}
      {error && !notReady ? <Notice tone="danger">{describeError(error)}</Notice> : null}
      {run ? <SearchRunView run={run} /> : null}
    </div>
  );
};
