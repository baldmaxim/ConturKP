import { useCallback, useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { isAbortError } from '../api/client';
import { describeError } from '../api/errors';
import type { IAuditEvent, IAuditPage, TAuditOutcome } from '../api/types';
import { Badge, type TBadgeTone } from '../components/Badge';
import { Button } from '../components/Button';
import type { TIconName } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { Notice } from '../components/Notice';
import { formatDateTime } from '../utils/datetime';
import { OUTCOME_LABELS, principalLabel } from '../utils/labels';
import list from '../styles/list.module.css';
import styles from './AuditLog.module.css';

const PAGE_SIZE = 50;

const OUTCOME_VIEW: Record<TAuditOutcome, { tone: TBadgeTone; icon: TIconName }> = {
  allowed: { tone: 'success', icon: 'check' },
  denied: { tone: 'warning', icon: 'shield-x' },
  failed: { tone: 'danger', icon: 'circle-x' },
};

interface IAuditLogProps {
  /** Загрузка страницы журнала по курсору. */
  loadPage: (cursor: string | null, limit: number, signal?: AbortSignal) => Promise<IAuditPage>;
  /** Ключ источника: при смене журнал перечитывается с начала. */
  sourceKey: string;
  emptyText: string;
}

export const AuditLog: FC<IAuditLogProps> = ({ loadPage, sourceKey, emptyText }) => {
  const [items, setItems] = useState<IAuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [token, setToken] = useState(0);
  const loadRef = useRef(loadPage);
  loadRef.current = loadPage;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setMoreError(null);
    loadRef
      .current(null, PAGE_SIZE, controller.signal)
      .then((page) => {
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) {
          return;
        }
        setError(reason);
        setLoading(false);
      });
    return () => controller.abort();
  }, [sourceKey, token]);

  const reload = useCallback(() => setToken((value) => value + 1), []);

  const loadMore = async (): Promise<void> => {
    if (!nextCursor) {
      return;
    }
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await loadRef.current(nextCursor, PAGE_SIZE);
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (reason) {
      setMoreError(describeError(reason));
    } finally {
      setLoadingMore(false);
    }
  };

  const actorText = (event: IAuditEvent): ReactNode =>
    event.actor ? (
      <>
        {event.actor.displayName} <span className={list.mono}>({event.actor.login})</span>
      </>
    ) : (
      <span className={list.muted}>без пользователя</span>
    );

  const entityText = (event: IAuditEvent): ReactNode =>
    event.entityType ? (
      <span className={list.mono}>
        {event.entityType}
        {event.entityId ? `: ${event.entityId}` : ''}
      </span>
    ) : (
      <span className={list.muted}>—</span>
    );

  const outcomeBadge = (event: IAuditEvent): ReactNode => {
    const view = OUTCOME_VIEW[event.outcome] ?? { tone: 'neutral' as const, icon: 'info' as const };
    return <Badge tone={view.tone} icon={view.icon} label={OUTCOME_LABELS[event.outcome] ?? event.outcome} />;
  };

  const detailsBlock = (event: IAuditEvent): ReactNode =>
    Object.keys(event.details ?? {}).length > 0 ? (
      <details className={styles.details}>
        <summary>Подробности</summary>
        <pre className={styles.json}>{JSON.stringify(event.details, null, 2)}</pre>
      </details>
    ) : null;

  if (loading) {
    return <LoadingState />;
  }
  if (error) {
    return <ErrorState error={error} onRetry={reload} />;
  }
  if (items.length === 0) {
    return <EmptyState icon="scroll-text" title="Событий нет" text={emptyText} />;
  }

  return (
    <div className={styles.log}>
      <div className={styles.toolbar}>
        <span className={list.muted}>Показано событий: {items.length}. Время — МСК.</span>
        <Button variant="ghost" icon="refresh-cw" onClick={reload}>
          Обновить
        </Button>
      </div>
      <div className={list.tableWrap}>
        <table className={list.table}>
          <thead>
            <tr>
              <th scope="col">Время</th>
              <th scope="col">Кто</th>
              <th scope="col">Действие</th>
              <th scope="col">Объект</th>
              <th scope="col">Итог</th>
            </tr>
          </thead>
          <tbody>
            {items.map((event) => (
              <tr key={event.id}>
                <td className={list.num}>{formatDateTime(event.occurredAt)}</td>
                <td>
                  <div>{actorText(event)}</div>
                  <div className={list.muted}>{principalLabel(event.principalKind)}</div>
                </td>
                <td>
                  <span className={list.mono}>{event.action}</span>
                  {detailsBlock(event)}
                </td>
                <td>{entityText(event)}</td>
                <td>{outcomeBadge(event)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={list.cards}>
        {items.map((event) => (
          <li key={event.id} className={list.card}>
            <div className={list.cardHead}>
              <span className={`${list.cardTitle} ${list.mono}`}>{event.action}</span>
              {outcomeBadge(event)}
            </div>
            <dl className={list.meta}>
              <dt>Время</dt>
              <dd className={list.num}>{formatDateTime(event.occurredAt)} МСК</dd>
              <dt>Кто</dt>
              <dd>
                {actorText(event)} · {principalLabel(event.principalKind)}
              </dd>
              <dt>Объект</dt>
              <dd>{entityText(event)}</dd>
            </dl>
            {detailsBlock(event)}
          </li>
        ))}
      </ul>
      {moreError ? <Notice tone="danger">{moreError}</Notice> : null}
      {hasMore && nextCursor ? (
        <div className={list.more}>
          <Button icon="chevron-right" loading={loadingMore} onClick={() => void loadMore()}>
            Показать ещё
          </Button>
        </div>
      ) : (
        <p className={`${list.muted} ${styles.end}`}>Показаны все события.</p>
      )}
    </div>
  );
};
