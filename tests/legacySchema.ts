// Тесты обновления прежних этапов строят данные кодом HEAD на прежней схеме. Общий расчёт видимости этапа читает
// происхождение вопроса (миграция 0041; Review 16-1, R16-01), поэтому на прежней схеме недостающие объекты добавляются
// в форме 0041 без проверок — как колонки 0026 в requirementsUpgrade20 — и убираются перед миграцией, которая
// создаёт их сама. Ожидания тестов обновления от этого не меняются. На схеме 0040 таблица цитат предложений уже есть:
// добавляются только колонки вопроса (`proposalTable: false`).
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
