// Этап 08: обновление схемы 0018 → 0019 на данных принятого этапа 07 (D-026). Существующие ревизии Q&A получают
// фрагменты в транзакции миграции; хэш прежнего снимка не меняется (строка Q&A — отдельной формы); решения
// импорта целы и по-прежнему только руководителя; на обновлённой базе работают реестр, снимок с Q&A и цитата.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidenceScopeContentHash, sourceSetContentHash } from '../packages/core/src/index.ts';
import { createPool, dropDatabase, migrate, MIGRATIONS_DIR, setupDatabase, type Pool } from '../packages/db/src/index.ts';
import { ADMIN_URL, createUser, idem, makeApp, TestClient, testConfig, type ITestDb } from './helpers.ts';

const name = `kontur_kp_test_upgrade08_${Date.now().toString(36)}`;
const urlFor = (user: string): string => {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = '';
  u.pathname = `/${name}`;
  return u.toString();
};
const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');

let pool: Pool;
const migrateTo = async (max: number): Promise<number> => {
  const dir = mkdtempSync(join(tmpdir(), `kontur-mig08-${max}-`));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= max)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  const m = new pg.Client({ connectionString: urlFor('kontur_migrator') });
  await m.connect();
  try {
    return (await migrate(m, { testMode: true, dir })).length;
  } finally {
    await m.end();
  }
};

beforeAll(async () => {
  await setupDatabase(ADMIN_URL, name);
  expect(await migrateTo(18)).toBe(18);
  pool = createPool(urlFor('kontur_app'), 5);
});
afterAll(async () => {
  await pool.end();
  await dropDatabase(ADMIN_URL, name);
});

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await pool.query(sql, params)).rows[0] as T;

const seed07 = async () => {
  const admin = await createUser(pool, 'admin', ['admin'], 'Администратор');
  const manager = await createUser(pool, 'manager', ['manager'], 'Руководитель');
  const eng = await createUser(pool, 'eng1', ['engineer'], 'Инженер 1');
  const { id: tender } = await one<{ id: string }>("INSERT INTO tender (code, title, created_by) VALUES ('U-8', 'Тендер U-8', $1) RETURNING id", [admin]);
  await pool.query("INSERT INTO tender_member (tender_id, user_id, member_role, assigned_by) VALUES ($1, $2, 'manager', $3), ($1, $4, 'engineer', $3)", [tender, manager, admin, eng]);
  const { id: stage } = await one<{ id: string }>("INSERT INTO tender_stage (tender_id, seq, title, created_by) VALUES ($1, 1, 'Этап', $2) RETURNING id", [tender, manager]);
  const pdf = randomBytes(32).toString('hex');
  await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 10, 'application/pdf', $2)", [pdf, `m/${pdf}`]);
  const { id: doc } = await one<{ id: string }>("INSERT INTO document (tender_id, title, name_key) VALUES ($1, 'тз.pdf', 'тз.pdf') RETURNING id", [tender]);
  const { id: rev } = await one<{ id: string }>('INSERT INTO document_revision (document_id, tender_id, blob_sha256, revision_seq, registered_by) VALUES ($1, $2, $3, 1, $4) RETURNING id', [doc, tender, pdf, eng]);
  const zip = randomBytes(32).toString('hex');
  await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 10, 'application/zip', $2)", [zip, `m/${zip}`]);
  const { id: run } = await one<{ id: string }>("INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256) VALUES ($1, $2, 'rdweb_export', $3) RETURNING id", [rev, tender, zip]);
  await pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [run]);
  await pool.query("INSERT INTO recognition_page (run_id, page_index, page_label, width_px, height_px, rotation, status) VALUES ($1, 0, '1', 2480, 3508, 0, 'recognized')", [run]);
  const text = 'Фасад должен быть облицован клинкером.';
  await pool.query(
    `INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, run_id, document_revision_id, origin, fragment_kind, fragment_key, ordinal, page_index, text, text_sha256)
     VALUES ($1, 'recognition_run', $2, $2, $3, 'recognized_text', 'text_block', 'b1', 1, 0, $4, $5)`,
    [tender, run, rev, text, sha(text)],
  );
  await pool.query("UPDATE recognition_run SET status = 'complete', engine_schema_version = '1', pages_total = 1, pages_recognized = 1, finished_at = now(), row_version = row_version + 1 WHERE id = $1", [run]);
  const { id: set } = await one<{ id: string }>("INSERT INTO source_set (stage_id, purpose) VALUES ($1, 'working') RETURNING id", [stage]);
  const { id: setRev } = await one<{ id: string }>('INSERT INTO source_set_revision (source_set_id, seq, created_by) VALUES ($1, 1, $2) RETURNING id', [set, eng]);
  await pool.query("INSERT INTO source_set_item (source_set_revision_id, document_revision_id, inclusion, decided_by) VALUES ($1, $2, 'included', $3)", [setRev, rev, eng]);
  const setHash = sourceSetContentHash([{ documentRevisionId: rev, blobSha256: pdf, inclusion: 'included' }]);
  await pool.query("UPDATE source_set_revision SET status = 'frozen', frozen_at = now(), frozen_by = $2, content_hash = $3, row_version = row_version + 1 WHERE id = $1", [setRev, eng, setHash]);
  const scopeHash = evidenceScopeContentHash(setHash, [{ unitType: 'document_recognition', documentRevisionId: rev, recognitionRunId: run }]);
  const c = await pool.connect();
  let scope: string;
  try {
    await c.query('BEGIN');
    scope = (await c.query<{ id: string }>('INSERT INTO evidence_scope (stage_id, tender_id, source_set_revision_id, input_version, content_hash, created_by) VALUES ($1, $2, $3, 0, $4, $5) RETURNING id', [stage, tender, setRev, scopeHash, eng])).rows[0]!.id;
    await c.query("INSERT INTO evidence_scope_item (scope_id, tender_id, unit_type, document_revision_id, recognition_run_id, inclusion_reason) VALUES ($1, $2, 'document_recognition', $3, $4, 'source_set_included')", [scope, tender, rev, run]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  // Q&A этапа 07: импорт, ветка, вопрос с двумя ревизиями (без ответа и с ответом).
  const man = randomBytes(32).toString('hex');
  await pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 10, 'application/json', $2)", [man, `m/${man}`]);
  const { id: imp } = await one<{ id: string }>("INSERT INTO qa_import (tender_id, seq, manifest_blob_sha256, format_version, imported_by) VALUES ($1, 1, $2, 'kontur.qa.v1', $3) RETURNING id", [tender, man, eng]);
  const { id: thread } = await one<{ id: string }>("INSERT INTO qa_thread (tender_id, external_ref, title, created_by) VALUES ($1, 'Q-1', 'Разъяснения', $2) RETURNING id", [tender, eng]);
  const { id: item } = await one<{ id: string }>("INSERT INTO qa_item (thread_id, tender_id, item_no) VALUES ($1, $2, '1') RETURNING id", [thread, tender]);
  const { id: qa1 } = await one<{ id: string }>(
    "INSERT INTO qa_item_revision (item_id, tender_id, seq, question, status, import_id, content_sha256) VALUES ($1, $2, 1, 'Класс бетона?', 'open', $3, $4) RETURNING id",
    [item, tender, imp, sha('q1')],
  );
  const { id: qa2 } = await one<{ id: string }>(
    "INSERT INTO qa_item_revision (item_id, tender_id, seq, question, answer, status, answered_at, import_id, content_sha256, supersedes_revision_id) VALUES ($1, $2, 2, 'Класс бетона?', 'B30', 'answered', now(), $3, $4, $5) RETURNING id",
    [item, tender, imp, sha('q2'), qa1],
  );
  const { id: decision } = await one<{ id: string }>(
    "INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by) VALUES ($1, $2, 'import_item', gen_random_uuid(), 'import_item_disposition', 'не применимо', 'дубликат', $3) RETURNING id",
    [tender, stage, manager],
  );
  return { tender, stage, scope, scopeHash, qa1, qa2, decision, eng, manager };
};

describe('обновление схемы 0018 → 0019 (D-026)', () => {
  it('данные 07 переживают 0019; Q&A получает фрагменты; хэш снимка прежний; решения импорта целы; приложение работает', async () => {
    const s = await seed07();
    const fragmentsBefore = (await one<{ n: number }>('SELECT count(*)::int AS n FROM evidence_fragment', [])).n;
    expect(await migrateTo(19)).toBe(1);
    // Ревизии Q&A: вопрос у обеих, ответ — у второй.
    const qa = await pool.query<{ qa_item_revision_id: string; origin: string; text: string }>(
      "SELECT qa_item_revision_id, origin, text FROM evidence_fragment WHERE source_unit_type = 'qa_item_revision' ORDER BY qa_item_revision_id = $1 DESC, ordinal",
      [s.qa1],
    );
    expect(qa.rows).toEqual([
      { qa_item_revision_id: s.qa1, origin: 'qa_question', text: 'Класс бетона?' },
      { qa_item_revision_id: s.qa2, origin: 'qa_question', text: 'Класс бетона?' },
      { qa_item_revision_id: s.qa2, origin: 'qa_answer', text: 'B30' },
    ]);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM evidence_fragment', [])).n).toBe(fragmentsBefore + 3);
    // Хэш существующего снимка прежний.
    expect((await one<{ h: string }>('SELECT evidence_scope_composition_hash($1) AS h', [s.scope])).h).toBe(s.scopeHash);
    // Решение импорта цело; новое решение импорта — по-прежнему только руководителя.
    expect(await one('SELECT decision_type, statement FROM decision WHERE id = $1', [s.decision])).toEqual({ decision_type: 'import_item_disposition', statement: 'не применимо' });
    const engDecision = await pool
      .query("INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by) VALUES ($1, $2, 'import_item', gen_random_uuid(), 'import_item_disposition', 'x', 'y', $3)", [s.tender, s.stage, s.eng])
      .then(() => 'ok', (e: { code?: string }) => e.code);
    expect(engDecision).toBe('42501');
    expect(await one('SELECT status FROM integration_status WHERE system = $1 AND component = $2', ['model', 'ModelGateway'])).toEqual({ status: 'VERIFIED_FIXTURE' });
    // Фрагменты Q&A пишет только транзакция создания ревизии.
    const late = await pool
      .query("INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, qa_item_revision_id, origin, fragment_kind, fragment_key, ordinal, text, text_sha256, locator) VALUES ($1, 'qa_item_revision', $2, $2, 'qa_answer', 'text_block', 'qa:x', 9, 'B30', $3, '{\"kind\": \"qa_item\", \"part\": \"answer\"}')", [s.tender, s.qa2, sha('B30')])
      .then(() => 'ok', (e: { code?: string }) => e.code);
    expect(late).toBe('55000');
    // Приложение на обновлённой базе: реестр на прежнем снимке, новый снимок включает Q&A, цитата ответа.
    const db = { pool, name, appUrl: urlFor('kontur_app'), migratorUrl: urlFor('kontur_migrator'), drop: async () => undefined } as unknown as ITestDb;
    const app = makeApp(db, undefined, testConfig());
    const mgr = new TestClient(app);
    expect((await mgr.login('manager')).status).toBe(200);
    const reg = await mgr.post(`/stages/${s.stage}/requirement-registries`, { evidenceScopeId: s.scope, reason: 'реестр на прежнем снимке' }, { headers: idem() });
    expect(reg.status, reg.text).toBe(201);
    const cnt = (await mgr.get(`/requirement-registries/${reg.body.id}/completeness`)).body.counts;
    expect(cnt).toMatchObject({ total_units: 1, unreviewed_units: 1 });
    const scope2 = await mgr.post(`/stages/${s.stage}/evidence-scopes`, {}, { headers: idem() });
    expect(scope2.status, scope2.text).toBe(201);
    expect(scope2.body.contentHash).not.toBe(s.scopeHash);
    expect((scope2.body.items as { unitType: string; qaItemRevisionId: string }[]).filter((i) => i.unitType === 'qa_item_revision').map((i) => i.qaItemRevisionId)).toEqual([s.qa2]);
    const answer = (await one<{ id: string }>("SELECT id FROM evidence_fragment WHERE qa_item_revision_id = $1 AND origin = 'qa_answer'", [s.qa2])).id;
    const cite = await mgr.get(`/evidence/${answer}`);
    expect(cite.status, cite.text).toBe(200);
    expect(cite.body).toMatchObject({ sourceKind: 'qa_item_revision', text: 'B30', qa: { itemNo: '1', part: 'answer', revisionSeq: 2 } });
  });
});
