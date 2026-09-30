import { useState, type FC } from 'react';
import { listNegotiationSessions } from '../../api/mailEndpoints';
import { AppLink } from '../../components/AppLink';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Notice } from '../../components/Notice';
import { useApiResource } from '../../hooks/useApiResource';
import { formatDateTime } from '../../utils/datetime';
import form from '../../styles/form.module.css';
import list from '../../styles/list.module.css';
import styles from '../mail/Mail.module.css';
import { ManifestUpload } from './ManifestUpload';

/**
 * Переговоры тендера (Q-06): сервис переговоров не подключён (BLOCKED_EXTERNAL), поэтому сессии приходят
 * файлом manifest. Исправление транскрипции — новая редакция; аудио — только ссылка и хэш.
 */
export const TenderNegotiationsPanel: FC<{ tenderId: string; canImport: boolean }> = ({ tenderId, canImport }) => {
  const [version, setVersion] = useState(0);
  const res = useApiResource((signal) => listNegotiationSessions(tenderId, signal), `negotiations:${tenderId}:${version}`);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  const items = res.data?.items ?? [];
  return (
    <div className={form.stack}>
      <Notice tone="warning" icon="mic">
        Сервис переговоров не подключён (внешняя зависимость Q-06): сессии импортируются файлом.
      </Notice>
      {canImport ? <ManifestUpload tenderId={tenderId} kind="negotiation" onImported={() => setVersion((v) => v + 1)} /> : null}
      {items.length === 0 ? (
        <EmptyState icon="mic" title="Переговоров пока нет" text="Импортируйте файл сессии переговоров с транскрипцией." />
      ) : (
        <ul className={styles.cards}>
          {items.map((s) => (
            <li key={s.id} className={list.card}>
              <AppLink className={list.rowLink} to={`/negotiation-sessions/${s.id}`}>
                {s.title ?? s.externalSessionId}
              </AppLink>
              <dl className={list.meta}>
                <dt>Начало</dt>
                <dd className={list.num}>{`${formatDateTime(s.startedAt)} МСК`}</dd>
                <dt>Редакций транскрипции</dt>
                <dd className={list.num}>{s.revisions}</dd>
                <dt>Аудио</dt>
                <dd className={styles.address}>{s.audioRef ?? 'не указано'}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
