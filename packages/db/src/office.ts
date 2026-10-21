// «Офис» в администрировании: фоновые задания worker'а для визуализации. Только очередь заданий — без полезной
// нагрузки, текстов ошибок и данных тендеров, к которым у смотрящего нет доступа.
import type { Queryable } from './pool.ts';

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

export const officeSnapshot = async (db: Queryable, visibleTenderIds: string[]): Promise<IOfficeSnapshot> => {
  const items = await db.query<IItemRow>(
    `SELECT kind, status, tender_id, hidden, count(*)::int AS n,
            (array_agg(last_error_code ORDER BY finished_at DESC, id) FILTER (WHERE status = 'failed'))[1] AS last_error_code,
            max(finished_at) FILTER (WHERE status = 'failed') AS last_failed_at
       FROM (
         SELECT id, kind, status, last_error_code, finished_at,
                CASE WHEN tender_id = ANY($1::uuid[]) THEN tender_id END AS tender_id,
                (tender_id IS NOT NULL AND NOT (tender_id = ANY($1::uuid[]))) AS hidden
           FROM job
          WHERE status IN ('queued', 'running') OR (status = 'failed' AND finished_at > now() - interval '24 hours')
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
  };
};
