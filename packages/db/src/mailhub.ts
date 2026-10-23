import type { IMailHubItem, IMailHubPage } from '@kontur/adapters';
import { enqueueJob } from './jobs.ts';
import { withTransaction, type Pool, type Queryable } from './pool.ts';

export interface IMailHubConnection {
  source_key: string;
  mailbox_id: string;
  actor_user_id: string;
  allowed_mailboxes: string[];
  cursor: string | null;
  since_at: Date | null;
  last_change_at: Date | null;
  enabled: boolean;
}
export const getMailHubConnection = async (
  db: Queryable,
  key: string,
): Promise<IMailHubConnection | null> =>
  (
    await db.query<IMailHubConnection>(
      'SELECT * FROM mailhub_connection WHERE source_key=$1',
      [key],
    )
  ).rows[0] ?? null;

// Идентичность — источник + внешний логический id, никогда тема или конкретная копия в ящике.
export const saveMailHubPage = async (
  db: Queryable,
  key: string,
  page: IMailHubPage,
): Promise<void> => {
  for (const item of page.items) {
    await db.query(
      `INSERT INTO mailhub_message(source_key,external_id,source_changed_at,copies) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(source_key,external_id) DO UPDATE SET source_changed_at=greatest(mailhub_message.source_changed_at,excluded.source_changed_at),copies=excluded.copies`,
      [key, item.id, item.changedAt, JSON.stringify(item.copies)],
    );
  }
  const stamp = page.items.length
    ? new Date(
        Math.max(...page.items.map((x) => Date.parse(x.changedAt))),
      ).toISOString()
    : null;
  await db.query(
    `UPDATE mailhub_connection SET cursor=$2,last_change_at=greatest($3,last_change_at),
    since_at=CASE WHEN $4 THEN since_at ELSE coalesce(greatest($3,last_change_at),now())-interval '10 minutes' END,
    next_poll_at=now()+CASE WHEN $4 THEN interval '0 seconds' ELSE interval '30 seconds' END,
    last_success_at=now(),last_error_code=NULL WHERE source_key=$1`,
    [key, page.hasMore ? page.nextCursor : null, stamp, page.hasMore],
  );
  await db.query(
    "UPDATE integration_status SET last_checked_at=now(),last_success_at=now(),last_error_code=NULL WHERE system='mailhub'",
  );
};

export const scheduleMailHub = async (pool: Pool, key: string): Promise<void> =>
  withTransaction(pool, async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('mailhub.schedule'),hashtext($1))",
      [key],
    );
    await db.query(
      `UPDATE mailhub_connection SET cursor=NULL,since_at=NULL,full_scan_at=now(),next_poll_at=now()
    WHERE source_key=$1 AND full_scan_at<now()-interval '1 day'`,
      [key],
    );
    const due = (
      await db.query(
        'SELECT source_key FROM mailhub_connection WHERE source_key=$1 AND enabled AND next_poll_at<=now()',
        [key],
      )
    ).rows;
    if (due.length)
      await enqueueJob(db, {
        kind: 'mailhub.sync',
        dedupeKey: `mailhub-sync:${key}`,
        payload: { sourceKey: key },
        priority: 6,
        resourceClass: 'network',
        maxAttempts: 3,
      });
    const pending = (
      await db.query<{ external_id: string }>(
        `SELECT m.external_id FROM mailhub_message m JOIN mailhub_connection c USING(source_key)
    WHERE m.source_key=$1 AND c.enabled AND m.import_id IS NULL AND m.retry_after<=now()
      AND NOT EXISTS(SELECT 1 FROM job j WHERE j.dedupe_key='mailhub-fetch:'||m.source_key||':'||m.external_id::text AND j.status IN('queued','running'))
    ORDER BY m.source_changed_at DESC,m.external_id LIMIT 3`,
        [key],
      )
    ).rows;
    const active = (
      await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM job WHERE kind='mailhub.fetch' AND status IN('queued','running')",
      )
    ).rows[0]!.n;
    for (const item of pending.slice(0, Math.max(0, 3 - active)))
      await enqueueJob(db, {
        kind: 'mailhub.fetch',
        dedupeKey: `mailhub-fetch:${key}:${item.external_id}`,
        payload: { sourceKey: key, itemId: item.external_id },
        priority: 6,
        resourceClass: 'network',
        maxAttempts: 3,
      });
  });

export const getMailHubImportSource = async (
  db: Queryable,
  importId: string,
): Promise<{ external_id: string; copies: IMailHubItem['copies'] } | null> =>
  (
    await db.query<{ external_id: string; copies: IMailHubItem['copies'] }>(
      'SELECT external_id,copies FROM mailhub_message WHERE import_id=$1',
      [importId],
    )
  ).rows[0] ?? null;
