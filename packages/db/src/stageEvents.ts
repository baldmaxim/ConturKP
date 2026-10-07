// Барьер актуальности этапа (state-machines §1.1, R01-03): событие вставляется в той же
// транзакции, что и изменение, под блокировкой строк затронутых этапов (по возрастанию id).
// Этап 13 (D-033 В-13-5): в той же транзакции — удержание (readiness_hold) для каждого действующего кандидата этапа,
// которого событие касается и которым не покрыто (правила покрытия — SQL-функции миграции 0034). Решения по
// удержаниям, принятие риска, согласование и выпуск событий не порождают (R01-07).
import type { Queryable } from './pool.ts';

export type StageEventType =
  | 'import_accepted'
  | 'document_revision_registered'
  | 'source_set_changed'
  | 'recognition_run_completed'
  | 'calculation_revision_added'
  // Этап 07: подтверждённая связь письма, редакция транскрипции, ревизии вопросов–ответов.
  | 'communication_linked'
  | 'transcript_revision_added'
  | 'qa_form_added'
  // Этап 08: решение по требованию (state-machines §1.1, И-08-9); значение есть в CHECK с миграции 0002.
  | 'decision_recorded'
  // Этап 11: новая версия значения поля приложения (класс content); значение есть в CHECK с миграции 0002.
  | 'draft_field_changed';

const CLASS_OF: Record<StageEventType, 'source' | 'calculation' | 'content'> = {
  import_accepted: 'source',
  document_revision_registered: 'source',
  source_set_changed: 'source',
  recognition_run_completed: 'source',
  calculation_revision_added: 'calculation',
  communication_linked: 'source',
  transcript_revision_added: 'source',
  qa_form_added: 'source',
  decision_recorded: 'content',
  draft_field_changed: 'content',
};

// Класс события по типу; неизвестный тип — «источник» (консервативно: неизвестное считается затрагивающим вход).
export const stageEventClass = (type: string): 'source' | 'calculation' | 'content' => (CLASS_OF as Record<string, 'source' | 'calculation' | 'content'>)[type] ?? 'source';

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
    const event = await db.query<{ id: string }>(
      `INSERT INTO stage_input_event (stage_id, seq, event_class, event_type, ref_type, ref_id, actor_user_id, actor_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [stageId, v.rows[0]!.input_version, CLASS_OF[e.eventType], e.eventType, e.refType, e.refId, e.actorUserId, e.actorUserId ? 'human' : 'system'],
    );
    await holdActiveCandidates(db, stageId, event.rows[0]!.id);
  }
  return stages.length;
};

// Кандидаты, для которых событие ставит удержание: собирается, готов, согласован, выпущен (отправки до этапа 15 нет).
export const ACTIVE_CANDIDATE_STATUSES = ['assembling', 'ready_for_approval', 'approved', 'released'] as const;

// Удержание по событию для действующих кандидатов этапа (под блокировкой этапа, в транзакции события).
export const holdActiveCandidates = async (db: Queryable, stageId: string, eventId: string): Promise<number> =>
  (
    await db.query(
      `INSERT INTO readiness_hold (candidate_id, tender_id, stage_id, input_event_id)
       SELECT c.id, c.tender_id, c.stage_id, $2 FROM release_candidate c
        WHERE c.stage_id = $1 AND c.status = ANY($3::text[]) AND stage_event_affects(c.id, $2) AND NOT stage_event_covered(c.id, $2)
       ON CONFLICT (candidate_id, input_event_id) DO NOTHING`,
      [stageId, eventId, ACTIVE_CANDIDATE_STATUSES],
    )
  ).rowCount ?? 0;

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
