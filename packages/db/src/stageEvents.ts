// Барьер актуальности этапа (state-machines §1.1, R01-03): событие вставляется в той же
// транзакции, что и изменение, под блокировкой строк затронутых этапов (по возрастанию id).
// Удержания кандидатов (readiness_hold) и задание инвалидации появятся вместе с кандидатами
// выпуска (этапы 12–13) и зависимостями (этап 09); сейчас кандидатов нет.
import type { Queryable } from './pool.ts';

export type StageEventType =
  | 'import_accepted'
  | 'document_revision_registered'
  | 'source_set_changed';

const CLASS_OF: Record<StageEventType, 'source'> = {
  import_accepted: 'source',
  document_revision_registered: 'source',
  source_set_changed: 'source',
};

export interface IStageEventInput {
  tenderId: string;
  // null — все активные этапы тендера (неизвестная применимость означает «затрагивает»).
  stageIds: string[] | null;
  eventType: StageEventType;
  refType: string;
  refId: string;
  actorUserId: string | null;
}

// Блокирует этапы тендера в едином порядке. Вызывается первой доменной блокировкой транзакции.
export const lockTenderStages = async (db: Queryable, tenderId: string, stageIds: string[] | null): Promise<string[]> => {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM tender_stage
      WHERE tender_id = $1 AND status = 'active' AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      ORDER BY id FOR UPDATE`,
    [tenderId, stageIds],
  );
  return r.rows.map((x) => x.id);
};

export const emitStageEvents = async (db: Queryable, e: IStageEventInput): Promise<number> => {
  const stages = await lockTenderStages(db, e.tenderId, e.stageIds);
  for (const stageId of stages) {
    const v = await db.query<{ input_version: number }>(
      'UPDATE tender_stage SET input_version = input_version + 1 WHERE id = $1 RETURNING input_version',
      [stageId],
    );
    await db.query(
      `INSERT INTO stage_input_event (stage_id, seq, event_class, event_type, ref_type, ref_id, actor_user_id, actor_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [stageId, v.rows[0]!.input_version, CLASS_OF[e.eventType], e.eventType, e.refType, e.refId, e.actorUserId, e.actorUserId ? 'human' : 'system'],
    );
  }
  return stages.length;
};

export interface IStageEventRow {
  id: string;
  stage_id: string;
  seq: number;
  event_class: string;
  event_type: string;
  ref_type: string;
  ref_id: string;
  actor_user_id: string | null;
  actor_kind: string;
  created_at: Date;
}

export const listStageEvents = async (db: Queryable, stageId: string, limit: number): Promise<IStageEventRow[]> => {
  const r = await db.query<IStageEventRow>(
    'SELECT * FROM stage_input_event WHERE stage_id = $1 ORDER BY seq DESC LIMIT $2',
    [stageId, limit],
  );
  return r.rows;
};
