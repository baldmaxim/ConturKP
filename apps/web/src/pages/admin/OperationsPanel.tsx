import type { FC } from 'react';
import { getOperations } from '../../api/operationsEndpoints';
import type { IIntegrationView, IOperationsView, TIntegrationStatus, TSpaceLevel } from '../../api/operationsTypes';
import { Badge, type TBadgeTone } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useApiResource } from '../../hooks/useApiResource';
import { usePolling } from '../../hooks/usePolling';
import { formatDateTime } from '../../utils/datetime';
import list from '../../styles/list.module.css';
import styles from './Operations.module.css';

const STATUS: Record<TIntegrationStatus, { label: string; tone: TBadgeTone; icon: 'shield-check' | 'info' | 'ban' | 'circle-dot' }> = {
  VERIFIED_LIVE: { label: 'Проверена живьём', tone: 'success', icon: 'shield-check' },
  VERIFIED_FIXTURE: { label: 'Только на поддельных данных', tone: 'info', icon: 'info' },
  BLOCKED_EXTERNAL: { label: 'Нужна доработка другой системы', tone: 'warning', icon: 'ban' },
  NOT_IMPLEMENTED: { label: 'Нет адаптера', tone: 'muted', icon: 'circle-dot' },
};

const SPACE: Record<TSpaceLevel, { label: string; tone: TBadgeTone }> = {
  ok: { label: 'Места достаточно', tone: 'success' },
  warn: { label: 'Мало места', tone: 'warning' },
  stop: { label: 'Запись остановлена: нет места', tone: 'danger' },
  unknown: { label: 'Свободное место не измерено', tone: 'muted' },
};

const JOB_STATUS: Record<string, string> = { queued: 'в очереди', running: 'выполняется', failed: 'отказ за 24 ч' };

const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
const gb = (bytes: number | null): string =>
  bytes === null ? '—' : bytes < 1024 ** 3 ? mb(bytes) : `${(bytes / 1024 ** 3).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГБ`;
const duration = (seconds: number | null): string => {
  if (seconds === null) return 'нет';
  if (seconds < 120) return `${seconds} с`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} мин`;
  return `${Math.round(seconds / 3600)} ч`;
};
const ageHours = (iso: string): number => (Date.now() - new Date(iso).getTime()) / 3_600_000;

const IntegrationRow: FC<{ i: IIntegrationView }> = ({ i }) => {
  const s = STATUS[i.status] ?? { label: i.status, tone: 'neutral' as const, icon: 'circle-dot' as const };
  return (
    <tr>
      <td>
        <span className={list.mono}>{`${i.system} / ${i.component}`}</span>
      </td>
      <td>
        <Badge label={s.label} icon={s.icon} tone={s.tone} />
        {i.lastErrorCode ? <p className={styles.problem}>{`Последняя ошибка: ${i.lastErrorCode}`}</p> : null}
      </td>
      <td className={list.num}>{i.lastCheckedAt ? `${formatDateTime(i.lastCheckedAt)} МСК` : '—'}</td>
      <td>{i.evidenceRef ? <span className={list.mono}>{i.evidenceRef}</span> : <span className={list.muted}>—</span>}</td>
    </tr>
  );
};

// Смартфон: карточка вместо строки таблицы (BRAND.md §7.4).
const IntegrationCard: FC<{ i: IIntegrationView }> = ({ i }) => {
  const s = STATUS[i.status] ?? { label: i.status, tone: 'neutral' as const, icon: 'circle-dot' as const };
  return (
    <li className={list.card}>
      <span className={list.mono}>{`${i.system} / ${i.component}`}</span>
      <span>
        <Badge label={s.label} icon={s.icon} tone={s.tone} />
      </span>
      <dl className={list.meta}>
        <dt>Проверено</dt>
        <dd className={list.num}>{i.lastCheckedAt ? `${formatDateTime(i.lastCheckedAt)} МСК` : '—'}</dd>
        {i.lastErrorCode ? (
          <>
            <dt>Ошибка</dt>
            <dd>{i.lastErrorCode}</dd>
          </>
        ) : null}
        {i.evidenceRef ? (
          <>
            <dt>Основание</dt>
            <dd className={list.mono}>{i.evidenceRef}</dd>
          </>
        ) : null}
      </dl>
    </li>
  );
};

const Summary: FC<{ o: IOperationsView }> = ({ o }) => {
  const workerFresh = o.processes.some((p) => p.kind === 'worker' && Date.now() - new Date(p.lastSeenAt).getTime() < 60_000);
  const backupAge = o.backup.last ? ageHours(o.backup.last.finishedAt) : null;
  const space = SPACE[o.storage.level];
  return (
    <div className={styles.summary} aria-label="Сводка состояния">
      <Badge label={o.schema.ok ? `Схема БД ${o.schema.version}` : 'Схема БД не совпадает с кодом'} icon="layers" tone={o.schema.ok ? 'success' : 'danger'} />
      <Badge label={workerFresh ? 'Worker работает' : 'Worker не отвечает'} icon={workerFresh ? 'check' : 'server-off'} tone={workerFresh ? 'success' : 'danger'} />
      <Badge
        label={o.queue.overdueRunning > 0 ? `Зависших заданий: ${o.queue.overdueRunning}` : o.queue.failed24h > 0 ? `Отказов за сутки: ${o.queue.failed24h}` : 'Очередь в порядке'}
        icon="list-checks"
        tone={o.queue.overdueRunning > 0 ? 'danger' : o.queue.failed24h > 0 ? 'warning' : 'success'}
      />
      <Badge label={space.label} icon="archive" tone={space.tone} />
      <Badge
        label={!o.backup.configured ? 'Копии не настроены' : backupAge === null ? 'Копий ещё нет' : backupAge > 26 ? `Копия старше суток` : 'Копия свежая'}
        icon="shield-check"
        tone={!o.backup.configured || backupAge === null || backupAge > 26 ? 'warning' : 'success'}
      />
      {o.workerMode === 'restore_check' ? <Badge label="Проверка восстановленной копии" icon="info" tone="info" /> : null}
    </div>
  );
};

/** Состояние установки (этап 17): процессы, очередь, слот GPU, хранилище, последняя копия, статусы интеграций. */
export const OperationsPanel: FC = () => {
  const res = useApiResource((signal) => getOperations(signal), 'admin-operations');
  usePolling(true, res.reload, 15_000);
  if (res.loading && !res.data) return <LoadingState />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const o = res.data;
  const queueRows = o.queue.byKind.filter((q) => q.count > 0);
  return (
    <div className={styles.section}>
      <div className={styles.toolbar}>
        <Summary o={o} />
        <Button icon="refresh-cw" variant="ghost" onClick={res.reload}>
          Обновить
        </Button>
      </div>
      <div className={styles.grid}>
        <section className={list.card} aria-labelledby="ops-build">
          <h2 className={styles.sectionTitle} id="ops-build">
            Установка
          </h2>
          <dl className={list.meta}>
            <dt>Сборка</dt>
            <dd className={list.mono}>{o.build ?? 'не задана (KONTUR_BUILD)'}</dd>
            <dt>Схема БД</dt>
            <dd>{o.schema.ok ? `${o.schema.version}, миграций ${o.schema.migrations}` : o.schema.problem}</dd>
            <dt>Режим</dt>
            <dd>{o.env}</dd>
          </dl>
        </section>
        <section className={list.card} aria-labelledby="ops-storage">
          <h2 className={styles.sectionTitle} id="ops-storage">
            Хранилище
          </h2>
          <dl className={list.meta}>
            <dt>Свободно</dt>
            <dd className={list.num}>{gb(o.storage.freeBytes)}</dd>
            <dt>Пороги</dt>
            <dd>{o.storage.stopFreeBytes > 0 ? `предупреждение ${gb(o.storage.warnFreeBytes)}, остановка записи ${gb(o.storage.stopFreeBytes)}` : 'выключены'}</dd>
            <dt>Файлов</dt>
            <dd className={list.num}>{`${o.storage.blobs.count.toLocaleString('ru-RU')} · ${gb(o.storage.blobs.bytes)}`}</dd>
          </dl>
        </section>
        <section className={list.card} aria-labelledby="ops-backup">
          <h2 className={styles.sectionTitle} id="ops-backup">
            Резервная копия
          </h2>
          {o.backup.last ? (
            <dl className={list.meta}>
              <dt>Последняя</dt>
              <dd className={list.num}>{`${formatDateTime(o.backup.last.finishedAt)} МСК`}</dd>
              <dt>Состав</dt>
              <dd>{`схема ${o.backup.last.schemaVersion}, дамп ${mb(o.backup.last.dumpBytes)}, файлов ${o.backup.last.files} (${gb(o.backup.last.filesBytes)})`}</dd>
              <dt>Каталог</dt>
              <dd className={list.mono}>{o.backup.last.name}</dd>
            </dl>
          ) : (
            <p className={list.muted}>{o.backup.configured ? 'Завершённых копий нет. Запустите npm run ops:backup.' : 'Каталог копий (BACKUP_ROOT) не задан в настройках сервера.'}</p>
          )}
          {o.backup.problem ? <p className={styles.problem}>{o.backup.problem}</p> : null}
        </section>
        <section className={`${list.card} ${styles.wide}`} aria-labelledby="ops-queue">
          <h2 className={styles.sectionTitle} id="ops-queue">
            Очередь заданий
          </h2>
          <p className={list.muted}>
            {`Старейшее ожидающее — ${duration(o.queue.oldestQueuedSeconds)}. Слот GPU: ${o.queue.gpu.holderKind ? `занят (${o.queue.gpu.holderKind})` : 'свободен'}.`}
          </p>
          {queueRows.length === 0 ? (
            <p className={list.muted}>Активных заданий и отказов за сутки нет.</p>
          ) : (
            <div className={list.tableWrap}>
              <table className={list.table}>
                <thead>
                  <tr>
                    <th scope="col">Вид</th>
                    <th scope="col">Состояние</th>
                    <th scope="col" className={list.num}>
                      Число
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {queueRows.map((q) => (
                    <tr key={`${q.kind}:${q.status}`}>
                      <td className={list.mono}>{q.kind}</td>
                      <td>{JOB_STATUS[q.status] ?? q.status}</td>
                      <td className={list.num}>{q.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {queueRows.length > 0 ? (
            <ul className={styles.plain}>
              {queueRows.map((q) => (
                <li key={`${q.kind}:${q.status}`} className={styles.mobileOnly}>
                  <span className={list.mono}>{q.kind}</span>
                  {` — ${JOB_STATUS[q.status] ?? q.status}: ${q.count}`}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section className={`${list.card} ${styles.wide}`} aria-labelledby="ops-integrations">
          <h2 className={styles.sectionTitle} id="ops-integrations">
            Интеграции
          </h2>
          <div className={list.tableWrap}>
            <table className={list.table}>
              <thead>
                <tr>
                  <th scope="col">Система / компонент</th>
                  <th scope="col">Статус</th>
                  <th scope="col">Проверено</th>
                  <th scope="col">Основание живой проверки</th>
                </tr>
              </thead>
              <tbody>
                {o.integrations.map((i) => (
                  <IntegrationRow key={`${i.system}:${i.component}`} i={i} />
                ))}
              </tbody>
            </table>
          </div>
          <ul className={list.cards}>
            {o.integrations.map((i) => (
              <IntegrationCard key={`${i.system}:${i.component}`} i={i} />
            ))}
          </ul>
        </section>
        <section className={`${list.card} ${styles.wide}`} aria-labelledby="ops-processes">
          <h2 className={styles.sectionTitle} id="ops-processes">
            Процессы за сутки
          </h2>
          {o.processes.length === 0 ? (
            <p className={list.muted}>Отметок процессов нет: worker не запускался.</p>
          ) : (
            <ul className={styles.plain}>
              {o.processes.map((p) => (
                <li key={`${p.pid}:${p.startedAt}`} className={list.muted}>
                  {`${p.kind}, PID ${p.pid}: запущен ${formatDateTime(p.startedAt)}, последняя отметка ${formatDateTime(p.lastSeenAt)} МСК`}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};
