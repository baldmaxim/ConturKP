// S18-08: допустимый состав с причинами исключения больше общего JSON-лимита 100 КиБ.
// Настоящий API, свои документы, сохранение в БД; лимиты остальных команд и ACL остаются.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildZip, fakePdf } from './zip.ts';

let db: ITestDb;
let scenario: IScenario;
let revisionId: string;
let etag: string;
let payload: { items: { documentRevisionId: string; inclusion: 'excluded_not_applicable'; reason: string }[] };
const config = testConfig();

beforeAll(async () => {
  db = await createTestDb();
  scenario = await buildScenario(db, makeApp(db, undefined, config));
  const archive = buildZip(Array.from({ length: 32 }, (_, n) => ({ name: `drawing-${n}.pdf`, data: fakePdf(`drawing-${n}`) })));
  const imported = await scenario.eng1.post(`/stages/${scenario.stageA}/imports?name=drawings.zip`, archive, { headers: { ...idem(), 'Content-Type': 'application/octet-stream' } });
  expect(imported.status).toBe(202);
  await drain(makeWorker(db, config));
  const batch = (await scenario.eng1.get(`/imports/${imported.body.id}`)).body;
  expect(batch.items).toHaveLength(32);
  const reason = 'Не применяется к выбранному варианту. ' + 'я'.repeat(1900);
  payload = { items: batch.items.map((item: { documentRevisionId: string }) => ({ documentRevisionId: item.documentRevisionId, inclusion: 'excluded_not_applicable', reason })) };
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(100 * 1024);
  const draft = await scenario.eng1.post(`/stages/${scenario.stageA}/source-set-revisions`, {}, { headers: idem() });
  expect(draft.status).toBe(201);
  revisionId = draft.body.id;
  etag = draft.headers.etag;
});
afterAll(async () => { if (db) await db.drop(); });

describe('S18-08: HTTP-лимит большого состава источников', () => {
  it('допустимый состав больше 100 КиБ сохраняется целиком', async () => {
    const response = await scenario.eng1.put(`/source-set-revisions/${revisionId}/items`, payload, { headers: { 'If-Match': etag } });
    expect(response.status, response.text).toBe(200);
    const persisted = await db.pool.query('SELECT count(*)::int AS n FROM source_set_item WHERE source_set_revision_id=$1', [revisionId]);
    expect(persisted.rows[0].n).toBe(32);
  });

  it('большое тело не обходит изоляцию чужого этапа', async () => {
    const response = await scenario.eng3.put(`/source-set-revisions/${revisionId}/items`, payload, { headers: { 'If-Match': etag } });
    expect(response.status, response.text).toBe(404);
  });

  it('обычная команда сохраняет предел 100 КиБ', async () => {
    const response = await scenario.eng1.post('/tenders', payload, { headers: idem() });
    expect(response.status).toBe(413);
  });

  it('состав сверх 1 МиБ отклоняется до исполнения', async () => {
    const response = await scenario.eng1.put(`/source-set-revisions/${revisionId}/items`, { padding: 'x'.repeat(1024 * 1024 + 1) }, { headers: { 'If-Match': etag } });
    expect(response.status).toBe(413);
  });
});
