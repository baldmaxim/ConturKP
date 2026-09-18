// Тендеры, участники, этапы (data-model §4.2). Условие области тендера — в каждом запросе
// (ADR-006 §6): карточку видит участник или администратор, этапы — только участник.
import type { MemberRole } from '@kontur/core';
import { contentTenderIds, type IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

export interface ITenderRow {
  id: string;
  code: string;
  title: string;
  customer_name: string | null;
  object_name: string | null;
  status: 'active' | 'archived';
  row_version: number;
  created_at: Date;
  updated_at: Date;
  member_role: MemberRole | null;
}

const SELECT_TENDER = `
  SELECT t.id, t.code, t.title, t.customer_name, t.object_name, t.status, t.row_version,
         t.created_at, t.updated_at,
         CASE WHEN m.member_role = ANY($2::text[]) THEN m.member_role END AS member_role
    FROM tender t
    LEFT JOIN tender_member m ON m.tender_id = t.id AND m.user_id = $1 AND m.removed_at IS NULL`;

const VISIBLE = `($3::boolean OR m.member_role = ANY($2::text[]))`;

const scopeArgs = (ctx: IAccessContext): [string, string[], boolean] => [
  ctx.principal.userId,
  [...ctx.roles],
  ctx.roles.has('admin'),
];

export const listTenders = async (db: Queryable, ctx: IAccessContext): Promise<ITenderRow[]> => {
  const r = await db.query<ITenderRow>(`${SELECT_TENDER} WHERE ${VISIBLE} ORDER BY t.created_at DESC`, scopeArgs(ctx));
  return r.rows;
};

// lock = true блокирует строку тендера (порядок блокировок: тендер → этап).
export const getTender = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<ITenderRow | null> => {
  const r = await db.query<ITenderRow>(
    `${SELECT_TENDER} WHERE t.id = $4 AND ${VISIBLE}${lock ? ' FOR UPDATE OF t' : ''}`,
    [...scopeArgs(ctx), id],
  );
  return r.rows[0] ?? null;
};

export interface INewTender {
  code: string;
  title: string;
  customerName: string | null;
  objectName: string | null;
}

export const insertTender = async (db: Queryable, ctx: IAccessContext, t: INewTender): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO tender (code, title, customer_name, object_name, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [t.code, t.title, t.customerName, t.objectName, ctx.principal.userId],
  );
  return r.rows[0]!.id;
};

export interface ITenderPatch {
  title?: string | undefined;
  customerName?: string | null | undefined;
  objectName?: string | null | undefined;
  status?: 'active' | 'archived' | undefined;
}

// Поле, отсутствующее в patch, не меняется; null явно очищает необязательное поле.
export const updateTender = async (db: Queryable, _ctx: IAccessContext, id: string, p: ITenderPatch): Promise<void> => {
  await db.query(
    `UPDATE tender
        SET title = CASE WHEN $2 THEN $3 ELSE title END,
            customer_name = CASE WHEN $4 THEN $5 ELSE customer_name END,
            object_name = CASE WHEN $6 THEN $7 ELSE object_name END,
            status = CASE WHEN $8 THEN $9 ELSE status END,
            updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [
      id,
      p.title !== undefined, p.title ?? null,
      p.customerName !== undefined, p.customerName ?? null,
      p.objectName !== undefined, p.objectName ?? null,
      p.status !== undefined, p.status ?? null,
    ],
  );
};

// Изменение состава участников повышает версию тендера: If-Match назначений — по ETag тендера.
export const bumpTenderVersion = async (db: Queryable, id: string): Promise<void> => {
  await db.query('UPDATE tender SET row_version = row_version + 1, updated_at = now() WHERE id = $1', [id]);
};

export interface IMemberRow {
  user_id: string;
  login: string;
  display_name: string;
  member_role: MemberRole;
  assigned_at: Date;
  assigned_by_id: string | null;
  assigned_by_name: string | null;
}

export const listMembers = async (db: Queryable, _ctx: IAccessContext, tenderId: string): Promise<IMemberRow[]> => {
  const r = await db.query<IMemberRow>(
    `SELECT m.user_id, u.login, u.display_name, m.member_role, m.assigned_at,
            a.id AS assigned_by_id, a.display_name AS assigned_by_name
       FROM tender_member m
       JOIN app_user u ON u.id = m.user_id
       LEFT JOIN app_user a ON a.id = m.assigned_by
      WHERE m.tender_id = $1 AND m.removed_at IS NULL
      ORDER BY m.member_role DESC, u.display_name`,
    [tenderId],
  );
  return r.rows;
};

export const activeMembership = async (
  db: Queryable,
  tenderId: string,
  userId: string,
): Promise<{ id: string; member_role: MemberRole } | null> => {
  const r = await db.query<{ id: string; member_role: MemberRole }>(
    'SELECT id, member_role FROM tender_member WHERE tender_id = $1 AND user_id = $2 AND removed_at IS NULL',
    [tenderId, userId],
  );
  return r.rows[0] ?? null;
};

export const countActiveEngineers = async (db: Queryable, tenderId: string): Promise<number> => {
  const r = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM tender_member WHERE tender_id = $1 AND member_role = 'engineer' AND removed_at IS NULL`,
    [tenderId],
  );
  return r.rows[0]?.n ?? 0;
};

export const insertMember = async (
  db: Queryable,
  ctx: IAccessContext,
  tenderId: string,
  userId: string,
  memberRole: MemberRole,
): Promise<void> => {
  await db.query(
    'INSERT INTO tender_member (tender_id, user_id, member_role, assigned_by) VALUES ($1, $2, $3, $4)',
    [tenderId, userId, memberRole, ctx.principal.userId],
  );
};

export const removeMember = async (db: Queryable, ctx: IAccessContext, membershipId: string): Promise<void> => {
  await db.query('UPDATE tender_member SET removed_at = now(), removed_by = $2 WHERE id = $1 AND removed_at IS NULL', [
    membershipId,
    ctx.principal.userId,
  ]);
};

export interface IStageRow {
  id: string;
  tender_id: string;
  seq: number;
  title: string;
  submission_deadline: Date | null;
  status: 'active' | 'archived';
  input_version: number;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}

const SELECT_STAGE = `
  SELECT id, tender_id, seq, title, submission_deadline, status, input_version, row_version, created_at, updated_at
    FROM tender_stage`;

export const listStages = async (db: Queryable, ctx: IAccessContext, tenderId: string): Promise<IStageRow[]> => {
  const r = await db.query<IStageRow>(`${SELECT_STAGE} WHERE tender_id = $1 AND tender_id = ANY($2::uuid[]) ORDER BY seq`, [
    tenderId,
    contentTenderIds(ctx),
  ]);
  return r.rows;
};

export const getStage = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<IStageRow | null> => {
  const r = await db.query<IStageRow>(
    `${SELECT_STAGE} WHERE id = $1 AND tender_id = ANY($2::uuid[])${lock ? ' FOR UPDATE' : ''}`,
    [id, contentTenderIds(ctx)],
  );
  return r.rows[0] ?? null;
};

// Номер этапа — следующий по тендеру; вызывающий держит блокировку строки тендера.
export const insertStage = async (
  db: Queryable,
  ctx: IAccessContext,
  tenderId: string,
  s: { title: string; submissionDeadline: Date | null },
): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO tender_stage (tender_id, seq, title, submission_deadline, created_by)
     SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4 FROM tender_stage WHERE tender_id = $1
     RETURNING id`,
    [tenderId, s.title, s.submissionDeadline, ctx.principal.userId],
  );
  return r.rows[0]!.id;
};

export interface IStagePatch {
  title?: string | undefined;
  submissionDeadline?: Date | null | undefined;
}

export const updateStage = async (db: Queryable, _ctx: IAccessContext, id: string, p: IStagePatch): Promise<void> => {
  await db.query(
    `UPDATE tender_stage
        SET title = CASE WHEN $2 THEN $3 ELSE title END,
            submission_deadline = CASE WHEN $4 THEN $5::timestamptz ELSE submission_deadline END,
            updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [id, p.title !== undefined, p.title ?? null, p.submissionDeadline !== undefined, p.submissionDeadline ?? null],
  );
};
