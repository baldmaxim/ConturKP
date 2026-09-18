// Журнал действий (data-model §4.12): append-only, отказ — тоже событие (A25).
import type { IAccessContext } from './access.ts';
import type { Queryable } from './pool.ts';

export type AuditOutcome = 'allowed' | 'denied' | 'failed';
export type PrincipalKind = 'human' | 'model_via_mcp' | 'integration' | 'system' | 'anonymous';

export interface IAuditInput {
  actorUserId: string | null;
  principalKind: PrincipalKind;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  tenderId?: string | null;
  requestId?: string | null;
  outcome: AuditOutcome;
  details?: Record<string, unknown>;
}

export const writeAudit = async (db: Queryable, e: IAuditInput): Promise<void> => {
  await db.query(
    `INSERT INTO audit_event (actor_user_id, principal_id, principal_kind, action, entity_type, entity_id,
                              tender_id, request_id, outcome, details)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.actorUserId,
      e.principalKind,
      e.action,
      e.entityType ?? null,
      e.entityId ?? null,
      e.tenderId ?? null,
      e.requestId ?? null,
      e.outcome,
      JSON.stringify(e.details ?? {}),
    ],
  );
};

export const auditFor = (
  ctx: IAccessContext,
  e: Omit<IAuditInput, 'actorUserId' | 'principalKind' | 'requestId'>,
): IAuditInput => ({ ...e, actorUserId: ctx.principal.userId, principalKind: 'human', requestId: ctx.requestId });

export interface IAuditEventRow {
  id: string;
  seq: number;
  occurred_at: Date;
  actor_id: string | null;
  actor_login: string | null;
  actor_display_name: string | null;
  principal_kind: PrincipalKind;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  outcome: AuditOutcome;
  details: Record<string, unknown>;
}

const SELECT_EVENTS = `
  SELECT e.id, e.seq, e.occurred_at, u.id AS actor_id, u.login AS actor_login,
         u.display_name AS actor_display_name, e.principal_kind, e.action, e.entity_type,
         e.entity_id, e.outcome, e.details
    FROM audit_event e
    LEFT JOIN app_user u ON u.id = e.actor_user_id`;

// Право audit.read проверяется вызывающим обработчиком до вызова (ctx обязателен).
export const listTenderAudit = async (
  db: Queryable,
  _ctx: IAccessContext,
  tenderId: string,
  beforeSeq: number | null,
  limit: number,
): Promise<IAuditEventRow[]> => {
  const r = await db.query<IAuditEventRow>(
    `${SELECT_EVENTS}
      WHERE e.tender_id = $1 AND ($2::bigint IS NULL OR e.seq < $2)
      ORDER BY e.seq DESC LIMIT $3`,
    [tenderId, beforeSeq, limit],
  );
  return r.rows;
};

export const listGlobalAudit = async (
  db: Queryable,
  _ctx: IAccessContext,
  beforeSeq: number | null,
  limit: number,
): Promise<IAuditEventRow[]> => {
  const r = await db.query<IAuditEventRow>(
    `${SELECT_EVENTS}
      WHERE e.tender_id IS NULL AND ($1::bigint IS NULL OR e.seq < $1)
      ORDER BY e.seq DESC LIMIT $2`,
    [beforeSeq, limit],
  );
  return r.rows;
};
