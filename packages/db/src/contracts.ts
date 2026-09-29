// Договорной контур (D-017, D-022, D-023): договор, строки доступа, связь с тендером.
// Карточку видит пользователь с действующей выдачей по договору или администратор договоров
// (admin.contract) — без содержимого; содержимое — только с contract.read (fail-closed, OD-2).
// Физического удаления нет: архив договора и связи, отзыв выдачи (OD-5).
import { globalCapabilities, type ContractCapability, type ContractGrantCapability } from '@kontur/core';
import { grantedContractIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

export const isContractAdmin = (ctx: IAccessContext): boolean => globalCapabilities(ctx.roles).includes('admin.contract');

export interface IContractRow {
  id: string;
  number: string;
  title: string;
  counterparty: string | null;
  // Дата без времени — строкой YYYY-MM-DD, без сдвига часового пояса.
  signed_on: string | null;
  status: 'active' | 'archived';
  archived_at: Date | null;
  archived_by: string | null;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  updated_at: Date;
  row_version: number;
}

const SELECT_CONTRACT = `
  SELECT c.id, c.number, c.title, c.counterparty, c.signed_on::text AS signed_on, c.status, c.archived_at, c.archived_by,
         c.created_by, u.display_name AS created_by_name, c.created_at, c.updated_at, c.row_version
    FROM contract c JOIN app_user u ON u.id = c.created_by`;

export const listContracts = async (db: Queryable, ctx: IAccessContext): Promise<IContractRow[]> => {
  const r = await db.query<IContractRow>(
    `${SELECT_CONTRACT} WHERE ($1::boolean OR c.id = ANY($2::uuid[])) ORDER BY c.status, c.created_at DESC, c.id`,
    [isContractAdmin(ctx), grantedContractIds(ctx)],
  );
  return r.rows;
};

// Чужой договор — null (маршрут отвечает 404): существование не раскрывается (ADR-006 §7).
export const getContract = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<IContractRow | null> => {
  if (lock) await db.query('SELECT 1 FROM contract WHERE id = $1 FOR UPDATE', [id]);
  const r = await db.query<IContractRow>(`${SELECT_CONTRACT} WHERE c.id = $1 AND ($2::boolean OR c.id = ANY($3::uuid[]))`, [
    id,
    isContractAdmin(ctx),
    grantedContractIds(ctx),
  ]);
  return r.rows[0] ?? null;
};

export interface INewContract {
  number: string;
  title: string;
  counterparty: string | null;
  signedOn: string | null;
}

// Создатель получает доступ к созданному договору (OD-2) строками source = creator; какие именно
// возможности — решает вызывающий (packages/core CREATOR_CAPABILITIES). FK строки создателя сверяет автора.
export const insertContract = async (db: Queryable, ctx: IAccessContext, c: INewContract, creatorCaps: readonly ContractCapability[]): Promise<string> => {
  const r = await db.query<{ id: string }>(
    'INSERT INTO contract (number, title, counterparty, signed_on, created_by) VALUES ($1, $2, $3, $4::date, $5) RETURNING id',
    [c.number, c.title, c.counterparty, c.signedOn, ctx.principal.userId],
  );
  const id = r.rows[0]!.id;
  await db.query(
    `INSERT INTO contract_access (contract_id, user_id, capability, source, granted_by)
     SELECT $1, $2, cap, 'creator', $2 FROM unnest($3::text[]) AS cap`,
    [id, ctx.principal.userId, [...creatorCaps]],
  );
  return id;
};

export interface IContractPatch {
  number?: string | undefined;
  title?: string | undefined;
  counterparty?: string | null | undefined;
  signedOn?: string | null | undefined;
}

export const updateContract = async (db: Queryable, id: string, p: IContractPatch): Promise<void> => {
  await db.query(
    `UPDATE contract
        SET number = CASE WHEN $2 THEN $3 ELSE number END,
            title = CASE WHEN $4 THEN $5 ELSE title END,
            counterparty = CASE WHEN $6 THEN $7 ELSE counterparty END,
            signed_on = CASE WHEN $8 THEN $9::date ELSE signed_on END,
            updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [
      id,
      p.number !== undefined, p.number ?? null,
      p.title !== undefined, p.title ?? null,
      p.counterparty !== undefined, p.counterparty ?? null,
      p.signedOn !== undefined, p.signedOn ?? null,
    ],
  );
};

export const setContractStatus = async (db: Queryable, ctx: IAccessContext, id: string, status: 'active' | 'archived'): Promise<void> => {
  await db.query(
    `UPDATE contract
        SET status = $2,
            archived_at = CASE WHEN $2 = 'archived' THEN now() END,
            archived_by = CASE WHEN $2 = 'archived' THEN $3::uuid END,
            updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [id, status, ctx.principal.userId],
  );
};

// Изменение строк доступа повышает версию договора: If-Match выдач — по ETag договора.
export const bumpContractVersion = async (db: Queryable, id: string): Promise<void> => {
  await db.query('UPDATE contract SET row_version = row_version + 1, updated_at = now() WHERE id = $1', [id]);
};

// ---------------------------------------------------------------- Строки доступа

export interface IContractGrantRow {
  id: string;
  contract_id: string | null;
  user_id: string;
  login: string;
  display_name: string;
  user_roles: string[];
  capability: ContractGrantCapability;
  source: 'admin' | 'creator';
  granted_by: string;
  granted_by_name: string;
  granted_at: Date;
}

const SELECT_GRANT = `
  SELECT a.id, a.contract_id, a.user_id, u.login, u.display_name,
         coalesce((SELECT array_agg(r.role ORDER BY r.role) FROM user_role r WHERE r.user_id = u.id), '{}') AS user_roles,
         a.capability, a.source, a.granted_by, g.display_name AS granted_by_name, a.granted_at
    FROM contract_access a
    JOIN app_user u ON u.id = a.user_id
    JOIN app_user g ON g.id = a.granted_by`;

export const listContractGrants = async (db: Queryable, contractId: string): Promise<IContractGrantRow[]> => {
  const r = await db.query<IContractGrantRow>(
    `${SELECT_GRANT} WHERE a.contract_id = $1 AND a.revoked_at IS NULL ORDER BY u.display_name, a.capability`,
    [contractId],
  );
  return r.rows;
};

export const listCreatorGrants = async (db: Queryable): Promise<IContractGrantRow[]> => {
  const r = await db.query<IContractGrantRow>(
    `${SELECT_GRANT} WHERE a.contract_id IS NULL AND a.capability = 'contract.create' AND a.revoked_at IS NULL ORDER BY u.display_name`,
  );
  return r.rows;
};

export const activeGrantsOf = async (
  db: Queryable,
  contractId: string | null,
  userId: string,
): Promise<{ id: string; capability: ContractGrantCapability }[]> => {
  const r = await db.query<{ id: string; capability: ContractGrantCapability }>(
    'SELECT id, capability FROM contract_access WHERE contract_id IS NOT DISTINCT FROM $1 AND user_id = $2 AND revoked_at IS NULL',
    [contractId, userId],
  );
  return r.rows;
};

export const insertGrant = async (
  db: Queryable,
  ctx: IAccessContext,
  g: { contractId: string | null; userId: string; capability: ContractGrantCapability },
): Promise<void> => {
  await db.query(`INSERT INTO contract_access (contract_id, user_id, capability, source, granted_by) VALUES ($1, $2, $3, 'admin', $4)`, [
    g.contractId,
    g.userId,
    g.capability,
    ctx.principal.userId,
  ]);
};

export const revokeGrant = async (db: Queryable, ctx: IAccessContext, grantId: string): Promise<void> => {
  await db.query('UPDATE contract_access SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL', [grantId, ctx.principal.userId]);
};

// ---------------------------------------------------------------- Связь договора с тендером

export interface IContractLinkRow {
  id: string;
  contract_id: string;
  tender_id: string;
  stage_id: string | null;
  note: string | null;
  status: 'active' | 'archived';
  confirmed_by: string;
  confirmed_by_name: string;
  confirmed_at: Date;
  archived_by: string | null;
  archived_at: Date | null;
  archive_reason: string | null;
  updated_at: Date;
  row_version: number;
  tender_code: string;
  tender_title: string;
  stage_title: string | null;
  contract_number: string;
  contract_title: string;
  contract_status: 'active' | 'archived';
}

const SELECT_LINK = `
  SELECT l.id, l.contract_id, l.tender_id, l.stage_id, l.note, l.status, l.confirmed_by, u.display_name AS confirmed_by_name,
         l.confirmed_at, l.archived_by, l.archived_at, l.archive_reason, l.updated_at, l.row_version,
         t.code AS tender_code, t.title AS tender_title, s.title AS stage_title,
         c.number AS contract_number, c.title AS contract_title, c.status AS contract_status
    FROM contract_tender l
    JOIN contract c ON c.id = l.contract_id
    JOIN tender t ON t.id = l.tender_id
    JOIN app_user u ON u.id = l.confirmed_by
    LEFT JOIN tender_stage s ON s.id = l.stage_id`;

export const listContractLinks = async (db: Queryable, contractId: string): Promise<IContractLinkRow[]> => {
  const r = await db.query<IContractLinkRow>(`${SELECT_LINK} WHERE l.contract_id = $1 ORDER BY l.status, t.code, l.id`, [contractId]);
  return r.rows;
};

export const listTenderLinks = async (db: Queryable, tenderId: string): Promise<IContractLinkRow[]> => {
  const r = await db.query<IContractLinkRow>(`${SELECT_LINK} WHERE l.tender_id = $1 ORDER BY l.status, c.number, l.id`, [tenderId]);
  return r.rows;
};

export const getLink = async (db: Queryable, id: string, lock = false): Promise<IContractLinkRow | null> => {
  if (lock) await db.query('SELECT 1 FROM contract_tender WHERE id = $1 FOR UPDATE', [id]);
  const r = await db.query<IContractLinkRow>(`${SELECT_LINK} WHERE l.id = $1`, [id]);
  return r.rows[0] ?? null;
};

export const getLinkByPair = async (db: Queryable, contractId: string, tenderId: string): Promise<IContractLinkRow | null> => {
  const r = await db.query<IContractLinkRow>(`${SELECT_LINK} WHERE l.contract_id = $1 AND l.tender_id = $2`, [contractId, tenderId]);
  return r.rows[0] ?? null;
};

// Подтверждение связи: новая строка пары или возврат архивной в действие. Пара уникальна в БД,
// поэтому две одновременные попытки создать одну связь не дают двух строк (второй — 23505).
export const confirmLink = async (
  db: Queryable,
  ctx: IAccessContext,
  l: { contractId: string; tenderId: string; stageId: string | null; note: string | null; existingId: string | null },
): Promise<string> => {
  if (l.existingId) {
    await db.query(
      `UPDATE contract_tender
          SET status = 'active', stage_id = $2, note = $3, confirmed_by = $4, confirmed_at = now(),
              archived_by = NULL, archived_at = NULL, archive_reason = NULL, updated_at = now(), row_version = row_version + 1
        WHERE id = $1`,
      [l.existingId, l.stageId, l.note, ctx.principal.userId],
    );
    return l.existingId;
  }
  const r = await db.query<{ id: string }>(
    'INSERT INTO contract_tender (contract_id, tender_id, stage_id, note, confirmed_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [l.contractId, l.tenderId, l.stageId, l.note, ctx.principal.userId],
  );
  return r.rows[0]!.id;
};

export const updateLink = async (db: Queryable, id: string, p: { stageId?: string | null | undefined; note?: string | null | undefined }): Promise<void> => {
  await db.query(
    `UPDATE contract_tender
        SET stage_id = CASE WHEN $2 THEN $3::uuid ELSE stage_id END,
            note = CASE WHEN $4 THEN $5 ELSE note END,
            updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [id, p.stageId !== undefined, p.stageId ?? null, p.note !== undefined, p.note ?? null],
  );
};

export const archiveLink = async (db: Queryable, ctx: IAccessContext, id: string, reason: string): Promise<void> => {
  await db.query(
    `UPDATE contract_tender
        SET status = 'archived', archived_by = $2, archived_at = now(), archive_reason = $3, updated_at = now(), row_version = row_version + 1
      WHERE id = $1 AND status = 'active'`,
    [id, ctx.principal.userId, reason],
  );
};

// Договоры, действующе связанные с тендером: только их единицы предлагаются кандидатами в состав этапа.
export const activeLinkedContractIds = async (db: Queryable, tenderId: string): Promise<string[]> => {
  const r = await db.query<{ contract_id: string }>("SELECT contract_id FROM contract_tender WHERE tender_id = $1 AND status = 'active'", [tenderId]);
  return r.rows.map((x) => x.contract_id);
};
