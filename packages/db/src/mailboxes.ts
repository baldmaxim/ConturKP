// Почтовые ящики, выдачи и очередь импорта EML (этап 07, D-025: OD-07-2, OD-07-3, AD-07-3).
// Ящик регистрируется явно; администратор (admin.mailbox) ведёт ящики и выдачи, но содержимого писем
// без собственной mail.read и роли инженера или руководителя не видит. Выдача — строка на тройку
// «ящик, пользователь, возможность», как contract_access (D-022).
import type { MailCapability } from '@kontur/core';
import { mailCaps, type IAccessContext } from './access.ts';
import { enqueueJob } from './jobs.ts';
import type { Queryable } from './pool.ts';

export interface IMailboxRow {
  id: string;
  system: 'manual' | 'mailhub';
  external_account_id: string;
  display_name: string;
  status: 'active' | 'archived';
  created_by: string;
  created_at: Date;
  updated_at: Date;
  row_version: number;
  messages: number;
}

const SELECT_MAILBOX = `
  SELECT m.*, (SELECT count(*)::int FROM mail_message x WHERE x.mailbox_id = m.id) AS messages
    FROM mailbox m`;

// Ящики пользователя: с любой действующей выдачей; администратору — все (только служебные сведения).
export const listMailboxes = async (db: Queryable, ctx: IAccessContext, admin: boolean): Promise<IMailboxRow[]> => {
  const ids = [...ctx.mailGrants.keys()].filter((id) => mailCaps(ctx, id).length > 0);
  const r = await db.query<IMailboxRow>(`${SELECT_MAILBOX} WHERE $1 OR m.id = ANY($2::uuid[]) ORDER BY m.display_name, m.id`, [admin, ids]);
  return r.rows;
};

export const getMailbox = async (db: Queryable, id: string, lock = false): Promise<IMailboxRow | null> => {
  const r = await db.query<IMailboxRow>(`${SELECT_MAILBOX} WHERE m.id = $1${lock ? ' FOR UPDATE OF m' : ''}`, [id]);
  return r.rows[0] ?? null;
};

export const createMailbox = async (
  db: Queryable,
  m: { system: 'manual' | 'mailhub'; externalAccountId: string; displayName: string; createdBy: string },
): Promise<{ id: string } | { conflict: string }> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO mailbox (system, external_account_id, display_name, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (system, external_account_id) DO NOTHING RETURNING id`,
    [m.system, m.externalAccountId, m.displayName, m.createdBy],
  );
  if (r.rows[0]) return { id: r.rows[0].id };
  const e = await db.query<{ id: string }>('SELECT id FROM mailbox WHERE system = $1 AND external_account_id = $2', [m.system, m.externalAccountId]);
  return { conflict: e.rows[0]!.id };
};

export const updateMailbox = async (db: Queryable, id: string, patch: { displayName?: string; status?: 'active' | 'archived' }): Promise<void> => {
  await db.query(
    `UPDATE mailbox SET display_name = coalesce($2, display_name), status = coalesce($3, status), updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [id, patch.displayName ?? null, patch.status ?? null],
  );
};

// Выдачи меняют версию ящика: If-Match администратора ловит параллельную правку выдач.
export const bumpMailboxVersion = async (db: Queryable, id: string): Promise<void> => {
  await db.query('UPDATE mailbox SET updated_at = now(), row_version = row_version + 1 WHERE id = $1', [id]);
};

export interface ICommunicationIntegrationRow {
  system: string;
  component: string;
  status: string;
  last_checked_at: Date | null;
  last_success_at: Date | null;
  last_error_code: string | null;
  details: Record<string, unknown>;
}

// Состояние автоматических каналов почты и переговоров (BLOCKED_EXTERNAL до X-03 и Q-06).
export const communicationIntegrations = async (db: Queryable): Promise<ICommunicationIntegrationRow[]> => {
  const r = await db.query<ICommunicationIntegrationRow>(
    `SELECT system, component, status, last_checked_at, last_success_at, last_error_code, details FROM integration_status
      WHERE system IN ('mailhub', 'negotiations') ORDER BY system, component`,
  );
  return r.rows;
};

// ---------------------------------------------------------------- Выдачи

export interface IMailAccessRow {
  user_id: string;
  login: string;
  display_name: string;
  capabilities: MailCapability[];
}

export const listMailAccess = async (db: Queryable, mailboxId: string): Promise<IMailAccessRow[]> => {
  const r = await db.query<IMailAccessRow>(
    `SELECT a.user_id, u.login, u.display_name, array_agg(a.capability ORDER BY a.capability) AS capabilities
       FROM mail_access a JOIN app_user u ON u.id = a.user_id
      WHERE a.mailbox_id = $1 AND a.revoked_at IS NULL
      GROUP BY a.user_id, u.login, u.display_name
      ORDER BY u.display_name, u.login`,
    [mailboxId],
  );
  return r.rows;
};

// Полный набор возможностей пользователя по ящику: недостающие выдаются, лишние отзываются.
// Вызывающий держит блокировку строки ящика.
export const setMailAccess = async (
  db: Queryable,
  a: { mailboxId: string; userId: string; capabilities: MailCapability[]; actorId: string },
): Promise<{ granted: MailCapability[]; revoked: MailCapability[] }> => {
  const cur = await db.query<{ capability: MailCapability }>(
    'SELECT capability FROM mail_access WHERE mailbox_id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [a.mailboxId, a.userId],
  );
  const have = new Set(cur.rows.map((x) => x.capability));
  const want = new Set(a.capabilities);
  const granted = [...want].filter((c) => !have.has(c)).sort();
  const revoked = [...have].filter((c) => !want.has(c)).sort();
  if (revoked.length > 0) {
    await db.query(
      `UPDATE mail_access SET revoked_at = now(), revoked_by = $4
        WHERE mailbox_id = $1 AND user_id = $2 AND capability = ANY($3::text[]) AND revoked_at IS NULL`,
      [a.mailboxId, a.userId, revoked, a.actorId],
    );
  }
  for (const c of granted) {
    await db.query('INSERT INTO mail_access (mailbox_id, user_id, capability, granted_by) VALUES ($1, $2, $3, $4)', [
      a.mailboxId,
      a.userId,
      c,
      a.actorId,
    ]);
  }
  return { granted, revoked };
};

// ---------------------------------------------------------------- Импорт EML

export interface IMailImportRow {
  id: string;
  mailbox_id: string;
  raw_blob_sha256: string;
  file_name: string;
  direction: 'inbound' | 'outbound' | 'unknown';
  folder: string | null;
  link_tender_id: string | null;
  link_stage_id: string | null;
  status: 'queued' | 'done' | 'failed';
  failure_code: string | null;
  failure_detail: string | null;
  message_id: string | null;
  revision_id: string | null;
  created_revision: boolean | null;
  imported_by: string;
  created_at: Date;
  finished_at: Date | null;
}

export const MAIL_IMPORT_JOB = 'mail.import';

// Принятый файл и задание разбора — одной транзакцией вызывающего.
export const createMailImport = async (
  db: Queryable,
  i: {
    mailboxId: string;
    rawSha256: string;
    fileName: string;
    direction: 'inbound' | 'outbound' | 'unknown';
    folder: string | null;
    linkTenderId: string | null;
    linkStageId: string | null;
    importedBy: string;
  },
): Promise<IMailImportRow> => {
  const r = await db.query<IMailImportRow>(
    `INSERT INTO mail_import (mailbox_id, raw_blob_sha256, file_name, direction, folder, link_tender_id, link_stage_id, imported_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [i.mailboxId, i.rawSha256, i.fileName.slice(0, 255), i.direction, i.folder, i.linkTenderId, i.linkStageId, i.importedBy],
  );
  const row = r.rows[0]!;
  await enqueueJob(db, {
    kind: MAIL_IMPORT_JOB,
    dedupeKey: `mail-import:${row.id}`,
    payload: { importId: row.id },
    tenderId: i.linkTenderId,
    resourceClass: 'default',
  });
  return row;
};

export const getMailImport = async (db: Queryable, id: string, lock = false): Promise<IMailImportRow | null> => {
  const r = await db.query<IMailImportRow>(`SELECT * FROM mail_import WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return r.rows[0] ?? null;
};

export const listMailImports = async (db: Queryable, mailboxId: string, limit = 50): Promise<IMailImportRow[]> => {
  const r = await db.query<IMailImportRow>('SELECT * FROM mail_import WHERE mailbox_id = $1 ORDER BY created_at DESC, id LIMIT $2', [mailboxId, limit]);
  return r.rows;
};

export const finishMailImport = async (db: Queryable, id: string, o: { messageId: string; revisionId: string; created: boolean }): Promise<boolean> => {
  const r = await db.query(
    `UPDATE mail_import SET status = 'done', message_id = $2, revision_id = $3, created_revision = $4, finished_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status = 'queued'`,
    [id, o.messageId, o.revisionId, o.created],
  );
  return (r.rowCount ?? 0) > 0;
};

export const failMailImport = async (db: Queryable, id: string, code: string, detail: string): Promise<boolean> => {
  const r = await db.query(
    `UPDATE mail_import SET status = 'failed', failure_code = $2, failure_detail = $3, finished_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status = 'queued'`,
    [id, code.slice(0, 60), detail.slice(0, 2000)],
  );
  return (r.rowCount ?? 0) > 0;
};
