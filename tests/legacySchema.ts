// Тесты обновления прежних этапов строят данные кодом HEAD на прежней схеме. Общий расчёт видимости этапа читает
// происхождение вопроса (миграция 0041; Review 16-1, R16-01), поэтому на прежней схеме недостающие объекты добавляются
// в форме 0041 без проверок — как колонки 0026 в requirementsUpgrade20 — и убираются перед миграцией, которая
// создаёт их сама. Ожидания тестов обновления от этого не меняются. На схеме 0040 таблица цитат предложений уже есть:
// добавляются только колонки вопроса (`proposalTable: false`). Сборка кандидата читает решения о закрытом расчёте
// (миграция 0044; этап 18, D-044): на схеме до 0044 добавляются пустые таблицы решений и отзывов — без проверок, с правом
// чтения роли приложения — и функции предиката; всё убирается перед миграцией, которая создаёт их сама.
import pg from 'pg';

const run = async (migratorUrl: string, statements: string[]): Promise<void> => {
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    for (const sql of statements) await client.query(sql);
  } finally {
    await client.end();
  }
};

export const addQuestionOrigin = (migratorUrl: string, proposalTable = true): Promise<void> =>
  run(migratorUrl, [
    "ALTER TABLE customer_question ADD COLUMN source_proposal_id uuid, ADD COLUMN basis_requirement_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]",
    ...(proposalTable ? ['CREATE TABLE mcp_proposal_fragment (proposal_id uuid, fragment_id uuid)', 'GRANT SELECT ON mcp_proposal_fragment TO kontur_app'] : []),
  ]);

export const dropQuestionOrigin = (migratorUrl: string, proposalTable = true): Promise<void> =>
  run(migratorUrl, [...(proposalTable ? ['DROP TABLE mcp_proposal_fragment'] : []), 'ALTER TABLE customer_question DROP COLUMN source_proposal_id, DROP COLUMN basis_requirement_ids']);

// Функции 0044 повторяют миграцию: сервер HEAD читает их при оценке матрицы блокеров кандидата на любой схеме после 0034.
export const addClosureTables = (migratorUrl: string): Promise<void> =>
  run(migratorUrl, [
    'CREATE TABLE calculation_closure_decision (id uuid, tender_id uuid, stage_id uuid, calculation_revision_id uuid, decided_by uuid, reason text, decided_at timestamptz)',
    'CREATE TABLE calculation_closure_revocation (id uuid, decision_id uuid, revoked_by uuid, reason text, revoked_at timestamptz)',
    'GRANT SELECT ON calculation_closure_decision, calculation_closure_revocation TO kontur_app',
    `CREATE FUNCTION calculation_closed_by_decision(p_candidate uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
       SELECT EXISTS (
         SELECT 1 FROM release_candidate c
           JOIN candidate_input ci ON ci.candidate_id = c.id AND ci.kind = 'calculation_closure'
           JOIN calculation_closure_decision d ON d.id = ci.ref_id AND d.calculation_revision_id = c.calculation_revision_id AND d.stage_id = c.stage_id
          WHERE c.id = p_candidate
            AND (NOT EXISTS (SELECT 1 FROM calculation_closure_revocation v WHERE v.decision_id = d.id)
                 OR EXISTS (SELECT 1 FROM release r WHERE r.candidate_id = c.id)))
     $$`,
    `CREATE FUNCTION revision_economics_reconciled(p_revision uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
       SELECT coalesce((SELECT e.reconciliation_status = 'reconciled' FROM revision_economics e
                         WHERE e.revision_id = p_revision ORDER BY e.created_at DESC, e.id DESC LIMIT 1), false)
     $$`,
  ]);

export const dropClosureTables = (migratorUrl: string): Promise<void> =>
  run(migratorUrl, [
    'DROP FUNCTION calculation_closed_by_decision(uuid)',
    'DROP FUNCTION revision_economics_reconciled(uuid)',
    'DROP TABLE calculation_closure_revocation',
    'DROP TABLE calculation_closure_decision',
  ]);
