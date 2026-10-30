// «Офис» в администрировании: фоновые задания worker'а для визуализации. Только очередь заданий — без полезной
// нагрузки, текстов ошибок и данных тендеров, к которым у смотрящего нет доступа.
import type { Queryable } from './pool.ts';
import type { IJobProgress } from './jobs.ts';

export interface IOfficeTask {
  id: string | null;
  kind: string;
  tenderId: string | null;
  hidden: boolean;
  count: number;
  progress: IJobProgress | null;
}

export type OfficeJobStatus = 'queued' | 'running' | 'failed';

export interface IOfficeItem {
  kind: string;
  status: OfficeJobStatus;
  // Только видимый тендер; чужой не раскрывается — вместо него hidden.
  tenderId: string | null;
  hidden: boolean;
  count: number;
  // Для failed — код ошибки последнего по finished_at задания группы; текст ошибки не отдаётся никогда.
  lastErrorCode: string | null;
  lastFailedAt: Date | null;
}

export interface IOfficeSnapshot {
  // Время базы: от него считается «за последний час», часы браузера и сервера приложения не участвуют.
  at: Date;
  items: IOfficeItem[];
  tenders: Array<{ id: string; title: string }>;
  workersAlive: number;
  tasks: IOfficeTask[];
}

interface IItemRow {
  kind: string;
  status: OfficeJobStatus;
  tender_id: string | null;
  hidden: boolean;
  n: number;
  last_error_code: string | null;
  last_failed_at: Date | null;
}

// Один и тот же набор нерешённых отказов используется сводкой и диагностикой по запросу.
const OFFICE_JOBS_SQL = `WITH recent_failures AS MATERIALIZED (
       -- Один текущий отказ на логическое задание. Все прежние попытки остаются в job.
       SELECT DISTINCT ON (kind, tender_id, coalesce(dedupe_key, id::text))
              id, kind, status, tender_id, last_error_code, finished_at, dedupe_key, payload
         FROM job WHERE status = 'failed' AND finished_at > now() - interval '24 hours'
        ORDER BY kind, tender_id, coalesce(dedupe_key, id::text), finished_at DESC, id DESC
     ), successful_retries AS MATERIALIZED (
       -- Только ключи недавних отказов. История успехов читается один раз, а не для каждого job.
       SELECT recovered.kind, recovered.dedupe_key, max(recovered.finished_at) AS finished_at
         FROM job recovered
         JOIN (SELECT DISTINCT kind, dedupe_key FROM recent_failures WHERE dedupe_key IS NOT NULL) failed_keys
           ON failed_keys.kind = recovered.kind AND failed_keys.dedupe_key = recovered.dedupe_key
        WHERE recovered.status = 'succeeded' AND recovered.finished_at > now() - interval '24 hours'
        GROUP BY recovered.kind, recovered.dedupe_key
     ), resolved_failures AS MATERIALIZED (
       SELECT failed.id
         FROM recent_failures failed JOIN successful_retries recovered
           ON recovered.kind = failed.kind AND recovered.dedupe_key = failed.dedupe_key
        WHERE recovered.finished_at > failed.finished_at
       UNION
       SELECT failed.id
         FROM recent_failures failed
         JOIN recognition_run failed_run ON failed_run.id::text = failed.payload->>'runId'
         JOIN recognition_run recovered
           ON recovered.document_revision_id = failed_run.document_revision_id
          AND recovered.source_artifact_sha256 = failed_run.source_artifact_sha256
          AND recovered.engine = failed_run.engine
        WHERE failed.kind = 'recognition.local' AND recovered.status IN ('complete', 'partial')
          AND recovered.finished_at > failed.finished_at
       UNION
       SELECT failed.id FROM recent_failures failed JOIN integration_status model
         ON model.system = 'embedding_model' AND model.component = 'ModelGatewayEmbeddings'
        WHERE failed.kind = 'model.probe' AND model.last_error_code IS NULL
          AND model.last_success_at > failed.finished_at
       UNION
       -- Явный пропуск пользователем: импорт не подделывается, исходный отказ остаётся в истории.
       SELECT failed.id FROM recent_failures failed JOIN mailhub_message message
         ON message.source_key=failed.payload->>'sourceKey' AND message.external_id::text=failed.payload->>'itemId'
        WHERE failed.kind='mailhub.fetch' AND message.retry_after='infinity'::timestamptz
     ), current_jobs AS (
       SELECT id, kind, status, tender_id, last_error_code, finished_at FROM job WHERE status IN ('queued', 'running')
       UNION ALL
       SELECT failed.id, failed.kind, failed.status, failed.tender_id, failed.last_error_code, failed.finished_at
         FROM recent_failures failed LEFT JOIN resolved_failures resolved ON resolved.id = failed.id
        WHERE resolved.id IS NULL
     )`;

export const officeSnapshot = async (db: Queryable, visibleTenderIds: string[]): Promise<IOfficeSnapshot> => {
  const items = await db.query<IItemRow>(
    `${OFFICE_JOBS_SQL}
     SELECT kind, status, tender_id, hidden, count(*)::int AS n,
            (array_agg(last_error_code ORDER BY finished_at DESC, id) FILTER (WHERE status = 'failed'))[1] AS last_error_code,
            max(finished_at) FILTER (WHERE status = 'failed') AS last_failed_at
       FROM (
         SELECT id, kind, status, last_error_code, finished_at,
                CASE WHEN tender_id = ANY($1::uuid[]) THEN tender_id END AS tender_id,
                (tender_id IS NOT NULL AND NOT (tender_id = ANY($1::uuid[]))) AS hidden
           FROM current_jobs
       ) j
      GROUP BY kind, status, tender_id, hidden
      ORDER BY kind, status, tender_id NULLS FIRST`,
    [visibleTenderIds],
  );
  const shown = [...new Set(items.rows.map((r) => r.tender_id).filter((id): id is string => id !== null))];
  const tenders = shown.length
    ? await db.query<{ id: string; title: string }>('SELECT id, title FROM tender WHERE id = ANY($1::uuid[]) ORDER BY title, id', [shown])
    : { rows: [] };
  const workers = await db.query<{ n: number; at: Date }>(
    `SELECT count(*)::int AS n, now() AS at FROM process_heartbeat WHERE kind = 'worker' AND last_seen_at > now() - interval '1 minute'`,
  );
  // Только действующая попытка. Чужие задания объединяются по виду без ID и счётчиков обработки.
  const tasks = await db.query<IOfficeTask>(`SELECT CASE WHEN hidden THEN NULL ELSE id END AS id, kind,
      CASE WHEN hidden THEN NULL ELSE tender_id END AS "tenderId", hidden, count(*)::int AS count,
      CASE WHEN hidden THEN NULL ELSE progress END AS progress
    FROM (SELECT id, kind, tender_id, CASE WHEN locked_until > now() THEN progress END AS progress,
      tender_id IS NOT NULL AND NOT (tender_id = ANY($1::uuid[])) AS hidden FROM job WHERE status='running') j
    GROUP BY kind, hidden, CASE WHEN hidden THEN NULL ELSE id END,
      CASE WHEN hidden THEN NULL ELSE tender_id END, CASE WHEN hidden THEN NULL ELSE progress END
    ORDER BY kind, id NULLS LAST`, [visibleTenderIds]);
  return {
    at: workers.rows[0]!.at,
    items: items.rows.map((r) => ({
      kind: r.kind,
      status: r.status,
      tenderId: r.tender_id,
      hidden: r.hidden,
      count: r.n,
      lastErrorCode: r.last_error_code,
      lastFailedAt: r.last_failed_at,
    })),
    tenders: tenders.rows,
    workersAlive: workers.rows[0]?.n ?? 0,
    tasks: tasks.rows,
  };
};

export const OFFICE_DIAGNOSTIC_LIMIT = 50;
export interface IOfficeDiagnosticEntry {
  jobId: string;
  kind: string;
  tenderId: string | null;
  errorCode: string | null;
  failedAt: string;
  attempts: number;
  maxAttempts: number;
}
export interface IOfficeDiagnostics {
  at: Date;
  total: number;
  hidden: number;
  entries: IOfficeDiagnosticEntry[];
  limit: number;
  truncated: boolean;
}

/** Ограниченная техническая выборка без payload, текстов ошибок, адресов и содержимого документов.
 * Задания закрытых тендеров представлены только общим числом, без ID и индивидуальных записей. */
export const officeDiagnostics = async (db: Queryable, visibleTenderIds: string[], kinds: string[] | null = null): Promise<IOfficeDiagnostics> => {
  const result = await db.query<{ at: Date; total: number; hidden: number; entries: IOfficeDiagnosticEntry[] }>(
    `${OFFICE_JOBS_SQL}, eligible AS MATERIALIZED (
       SELECT * FROM current_jobs WHERE status = 'failed' AND ($2::text[] IS NULL OR kind = ANY($2))
     ), sample AS (
       SELECT e.id AS "jobId", e.kind, e.tender_id AS "tenderId", e.last_error_code AS "errorCode",
              e.finished_at AS "failedAt", j.attempts, j.max_attempts AS "maxAttempts"
         FROM eligible e JOIN job j ON j.id = e.id
        WHERE e.tender_id IS NULL OR e.tender_id = ANY($1::uuid[])
        ORDER BY e.finished_at DESC, e.id LIMIT $3
     )
     SELECT now() AS at, (SELECT count(*)::int FROM eligible) AS total,
            (SELECT count(*)::int FROM eligible WHERE tender_id IS NOT NULL AND NOT(tender_id = ANY($1::uuid[]))) AS hidden,
            COALESCE((SELECT json_agg(sample ORDER BY "failedAt" DESC, "jobId") FROM sample), '[]'::json) AS entries`,
    [visibleTenderIds, kinds, OFFICE_DIAGNOSTIC_LIMIT],
  );
  const row = result.rows[0]!;
  return { ...row, limit: OFFICE_DIAGNOSTIC_LIMIT, truncated: row.total - row.hidden > row.entries.length };
};

export interface IOfficeJobView {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'failed' | 'succeeded' | 'cancelled';
  tenderId: string | null;
  tenderTitle: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  progress: IJobProgress | null;
  nextCheckAt: Date | null;
  cancelRequested: boolean;
}
export interface IOfficeJobQuery {
  kinds: string[] | null;
  tender: string;
  status: 'active' | IOfficeJobView['status'];
  offset: number;
}
export const OFFICE_TASK_LIMIT = 50;

const JOB_COLUMNS = `j.id, j.kind, j.status, j.tender_id AS "tenderId", t.title AS "tenderTitle",
  j.created_at AS "createdAt", j.updated_at AS "updatedAt", j.finished_at AS "finishedAt",
  j.attempts, j.max_attempts AS "maxAttempts", j.last_error_code AS "errorCode",
  CASE WHEN j.status = 'running' AND j.locked_until > now() THEN j.progress END AS progress,
  CASE WHEN j.status='queued' THEN j.run_after
       WHEN j.status='failed' AND j.kind='mailhub.fetch' THEN
         (SELECT m.retry_after FROM mailhub_message m
           WHERE m.source_key=j.payload->>'sourceKey' AND m.external_id::text=j.payload->>'itemId' AND m.import_id IS NULL AND isfinite(m.retry_after))
  END AS "nextCheckAt", j.cancel_requested AS "cancelRequested"`;

/** Список актуальных заданий и результатов за сутки. Закрытые тендеры — только счётчиком.
 * Полезная нагрузка, путь документа, адреса и сообщение ошибки не покидают БД. */
export const officeTasks = async (db: Queryable, visibleTenderIds: string[], filter: IOfficeJobQuery) => {
  const result = await db.query<{ at: Date; total: number; hidden: number; counts: Record<IOfficeJobView['status'], number>; items: IOfficeJobView[] }>(
    `${OFFICE_JOBS_SQL}, eligible AS MATERIALIZED (
       SELECT id,kind,status,tender_id,finished_at FROM current_jobs
       UNION ALL
       SELECT id,kind,status,tender_id,finished_at FROM job
        WHERE status IN ('succeeded','cancelled') AND finished_at > now()-interval '24 hours'
     ), scoped AS MATERIALIZED (
       SELECT e.* FROM eligible e
        WHERE ($2::text[] IS NULL OR e.kind=ANY($2)) AND
          ($3='all' OR ($3='none' AND e.tender_id IS NULL)
           OR ($3='hidden' AND e.tender_id IS NOT NULL AND NOT(e.tender_id=ANY($1::uuid[]))) OR e.tender_id::text=$3)
     ), selected AS MATERIALIZED (
       SELECT * FROM scoped WHERE ($4='active' AND status IN ('queued','running','failed')) OR status=$4
     ), page AS (
       SELECT ${JOB_COLUMNS} FROM selected e JOIN job j ON j.id=e.id LEFT JOIN tender t ON t.id=j.tender_id
        WHERE e.tender_id IS NULL OR e.tender_id=ANY($1::uuid[])
        ORDER BY CASE e.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
                 j.created_at DESC,j.id DESC LIMIT $5 OFFSET $6
     )
     SELECT now() AS at,
       (SELECT count(*)::int FROM selected WHERE tender_id IS NULL OR tender_id=ANY($1::uuid[])) AS total,
       (SELECT count(*)::int FROM selected WHERE tender_id IS NOT NULL AND NOT(tender_id=ANY($1::uuid[]))) AS hidden,
       json_build_object('running',(SELECT count(*)::int FROM scoped WHERE status='running'),
         'queued',(SELECT count(*)::int FROM scoped WHERE status='queued'),
         'failed',(SELECT count(*)::int FROM scoped WHERE status='failed'),
         'succeeded',(SELECT count(*)::int FROM scoped WHERE status='succeeded'),
         'cancelled',(SELECT count(*)::int FROM scoped WHERE status='cancelled')) AS counts,
       COALESCE((SELECT json_agg(page ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,"createdAt" DESC,id DESC) FROM page),'[]'::json) AS items`,
    [visibleTenderIds, filter.kinds, filter.tender, filter.status, OFFICE_TASK_LIMIT, filter.offset],
  );
  const row = result.rows[0]!;
  return { ...row, limit: OFFICE_TASK_LIMIT, offset: filter.offset, hasMore: filter.offset + row.items.length < row.total };
};

/** Проверка прав повторяется для каждого открытия, в том числе после изменения доступа. */
export const officeTask = async (db: Queryable, visibleTenderIds: string[], id: string): Promise<IOfficeJobView | null> =>
  (await db.query<IOfficeJobView>(`SELECT ${JOB_COLUMNS} FROM job j LEFT JOIN tender t ON t.id=j.tender_id
    WHERE j.id=$2 AND (j.tender_id IS NULL OR j.tender_id=ANY($1::uuid[]))`, [visibleTenderIds, id])).rows[0] ?? null;
