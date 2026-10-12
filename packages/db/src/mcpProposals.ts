// Этап 16 (миграция 0040; проект §6): предложения чат-клиента. Предложение создаётся от имени пользователя, ничего не
// меняет и ждёт решения человека. Повтор с тем же `requestId` того же пользователя возвращает ту же запись (A37).
import { createHash } from 'node:crypto';
import type { Queryable } from './pool.ts';

export type McpProposalKind = 'finding' | 'question' | 'condition_text' | 'change_reason';
export type McpProposalStatus = 'open' | 'accepted' | 'rejected';

export interface IMcpProposalRow {
  id: string;
  tender_id: string;
  stage_id: string;
  kind: McpProposalKind;
  title: string | null;
  body: string;
  detail: Record<string, unknown>;
  request_id: string;
  request_sha256: string;
  api_token_id: string;
  on_behalf_of_user_id: string;
  on_behalf_of_name: string;
  status: McpProposalStatus;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  result_type: string | null;
  result_id: string | null;
  created_at: Date;
  row_version: number;
}

const COLUMNS = `p.id, p.tender_id, p.stage_id, p.kind, p.title, p.body, p.detail, p.request_id, p.request_sha256, p.api_token_id, p.on_behalf_of_user_id,
  u.display_name AS on_behalf_of_name, p.status, p.decided_by, d.display_name AS decided_by_name, p.decided_at, p.decision_reason, p.result_type, p.result_id,
  p.created_at, p.row_version::int AS row_version`;
const FROM = 'FROM mcp_proposal p JOIN app_user u ON u.id = p.on_behalf_of_user_id LEFT JOIN app_user d ON d.id = p.decided_by';

export interface INewMcpProposal {
  tenderId: string;
  stageId: string;
  kind: McpProposalKind;
  title: string | null;
  body: string;
  detail: Record<string, unknown>;
  fragmentIds: string[];
  requestId: string;
  tokenId: string;
  userId: string;
}

// Отпечаток содержимого: повтор с тем же `requestId`, но другим содержимым — не повтор, а ошибка клиента.
export const mcpProposalFingerprint = (p: Omit<INewMcpProposal, 'tokenId' | 'userId' | 'requestId'>): string =>
  createHash('sha256')
    .update(`kontur.mcp_proposal.v1\n${JSON.stringify([p.tenderId, p.stageId, p.kind, p.title, p.body, Object.entries(p.detail).sort(([a], [b]) => (a < b ? -1 : 1)), [...p.fragmentIds].sort()])}`, 'utf8')
    .digest('hex');

export const getMcpProposal = async (db: Queryable, id: string, lock = false): Promise<IMcpProposalRow | null> =>
  (await db.query<IMcpProposalRow>(`SELECT ${COLUMNS} ${FROM} WHERE p.id = $1${lock ? ' FOR UPDATE OF p' : ''}`, [id])).rows[0] ?? null;

export const findMcpProposalByRequest = async (db: Queryable, userId: string, requestId: string): Promise<IMcpProposalRow | null> =>
  (await db.query<IMcpProposalRow>(`SELECT ${COLUMNS} ${FROM} WHERE p.on_behalf_of_user_id = $1 AND p.request_id = $2`, [userId, requestId])).rows[0] ?? null;

export type McpProposalCreated = { state: 'created' | 'repeat'; row: IMcpProposalRow } | { state: 'request_reused'; row: IMcpProposalRow };

// Создание или повтор. Параллельные повторы одного `requestId` сериализуются блокировкой ключа.
export const createMcpProposal = async (db: Queryable, p: INewMcpProposal): Promise<McpProposalCreated> => {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['mcp_proposal', `${p.userId}:${p.requestId}`]);
  const fingerprint = mcpProposalFingerprint(p);
  const existing = await findMcpProposalByRequest(db, p.userId, p.requestId);
  if (existing) return { state: existing.request_sha256 === fingerprint ? 'repeat' : 'request_reused', row: existing };
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO mcp_proposal (tender_id, stage_id, kind, title, body, detail, request_id, request_sha256, api_token_id, on_behalf_of_user_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10) RETURNING id`,
      [p.tenderId, p.stageId, p.kind, p.title, p.body, JSON.stringify(p.detail), p.requestId, fingerprint, p.tokenId, p.userId],
    )
  ).rows[0]!.id;
  const unique = [...new Set(p.fragmentIds)];
  for (let i = 0; i < unique.length; i += 1) {
    await db.query('INSERT INTO mcp_proposal_fragment (proposal_id, fragment_id, ordinal) VALUES ($1, $2, $3)', [id, unique[i], i + 1]);
  }
  return { state: 'created', row: (await getMcpProposal(db, id))! };
};

export const listMcpProposals = async (db: Queryable, stageId: string, status?: McpProposalStatus): Promise<IMcpProposalRow[]> =>
  (
    await db.query<IMcpProposalRow>(`SELECT ${COLUMNS} ${FROM} WHERE p.stage_id = $1 AND ($2::text IS NULL OR p.status = $2) ORDER BY p.created_at DESC, p.id LIMIT 200`, [stageId, status ?? null])
  ).rows;

export const mcpProposalFragments = async (db: Queryable, proposalIds: readonly string[]): Promise<Map<string, string[]>> => {
  const out = new Map<string, string[]>();
  if (proposalIds.length === 0) return out;
  const r = await db.query<{ proposal_id: string; fragment_id: string }>('SELECT proposal_id, fragment_id FROM mcp_proposal_fragment WHERE proposal_id = ANY($1::uuid[]) ORDER BY proposal_id, ordinal', [[...proposalIds]]);
  for (const x of r.rows) out.set(x.proposal_id, [...(out.get(x.proposal_id) ?? []), x.fragment_id]);
  return out;
};

export interface IDecideMcpProposal {
  status: 'accepted' | 'rejected';
  userId: string;
  reason: string | null;
  resultType?: 'finding' | 'customer_question' | 'release_comparison_reason' | null;
  resultId?: string | null;
}

export const decideMcpProposal = async (db: Queryable, id: string, d: IDecideMcpProposal): Promise<void> => {
  await db.query(
    `UPDATE mcp_proposal SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4, result_type = $5, result_id = $6, row_version = row_version + 1
      WHERE id = $1`,
    [id, d.status, d.userId, d.reason, d.resultType ?? null, d.resultId ?? null],
  );
};

export const openMcpProposalCount = async (db: Queryable, stageId: string): Promise<number> =>
  Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM mcp_proposal WHERE stage_id = $1 AND status = 'open'", [stageId])).rows[0]!.n);
