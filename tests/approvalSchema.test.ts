// Этап 13 — вторая линия в БД (миграция 0034; проект §13): прямые записи роли kontur_app в обход API. Согласование,
// выпуск, принятие риска, удержания и возврат — только с правами человека и в допустимом состоянии; переходы кандидата —
// только по state-machines §11; записи неизменны; согласованное состояние проверяется в конце транзакции. Отпечаток
// содержимого этапа второй линии (0035–0036, R13-01, R13-05) совпадает с расчётом сервера и замечает изменение каждой
// записи входа.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { legacyStageContentFingerprint, stageContentFingerprint } from '../packages/db/src/index.ts';
import { idem } from './helpers.ts';
import { acceptAll, approve, assembled, buildStage13, closeStage13, notApplicable, release, view, type ICandidate13, type IStage13 } from './approvalFixtures.ts';
import { uploadDocument } from './searchFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let st: IStage13;
let c: ICandidate13;
let approvalId = '';
let releaseId = '';
let other: ICandidate13;

// Проба записи в транзакции, которая всегда откатывается; отложенные проверки — немедленно.
const probe = async (fn: (q: pg.PoolClient) => Promise<unknown>): Promise<string> => {
  const client = await st.db.pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    return 'ok';
  } catch (x) {
    return (x as { code?: string }).code ?? 'error';
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
};

const sql = (text: string, params: unknown[]) => probe((q) => q.query(text, params));

beforeAll(async () => {
  st = await buildStage13();
  c = await assembled(st);
  await acceptAll(st, c);
  c = await view(st, c.id);
  const a = await approve(st, c);
  expect(a.status, a.text).toBe(200);
  approvalId = a.body.approval.id as string;
  c = await view(st, c.id, st.e.s.eng1);
  const r = await release(st, c, approvalId);
  expect(r.status, r.text).toBe(201);
  releaseId = r.body.release.id as string;
  other = await assembled(st);
  // Событие после сборки: удержание у готового кандидата и решение руководителя по нему.
  await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'После сборки.pdf');
  expect(await notApplicable(st, other.id, 'Документ не влияет на комплект')).toBeGreaterThan(0);
});
afterAll(async () => {
  await closeStage13(st);
});

describe('согласование (approval)', () => {
  it('создаётся только по готовому кандидату с хэшем его манифеста; содержание неизменно; завершается один раз; удаление запрещено', async () => {
    const insert = (candidate: string, hash: string, by: string) =>
      sql('INSERT INTO approval (candidate_id, tender_id, stage_id, candidate_content_hash, input_version, gate, approved_by) VALUES ($1, $2, $3, $4, 0, \'{}\', $5)', [
        candidate, st.e.s.tenderA, st.e.s.stageA, hash, by,
      ]);
    expect(await insert(other.id, '0'.repeat(64), st.e.s.ids.manager)).toBe('23514');
    expect(await insert(c.id, c.contentHash, st.e.s.ids.manager)).toBe('23514');
    expect(await sql("UPDATE approval SET comment = 'подмена' WHERE id = $1", [approvalId])).toBe('55000');
    expect(await sql("UPDATE approval SET status = 'revoked', revoked_by = $2, revoke_reason = 'отзыв выпущенного', ended_at = now(), row_version = row_version + 1 WHERE id = $1", [
      approvalId, st.e.s.ids.manager,
    ])).toBe('23514');
    expect(await sql('DELETE FROM approval WHERE id = $1', [approvalId])).not.toBe('ok');
  });

  it('«согласован» без действующего согласования и прыжок «готов → выпущен» не допускаются', async () => {
    expect(await sql("UPDATE release_candidate SET status = 'approved', row_version = row_version + 1 WHERE id = $1", [other.id])).toBe('23514');
    expect(await sql("UPDATE release_candidate SET status = 'released', row_version = row_version + 1 WHERE id = $1", [other.id])).toBe('23514');
    expect(await sql("UPDATE release_candidate SET status = 'returned', row_version = row_version + 1 WHERE id = $1", [other.id])).toBe('23514');
  });
});

describe('выпуск (release)', () => {
  it('неизменен и не удаляется; второй выпуск кандидата — уникальность', async () => {
    expect(await sql("UPDATE release SET mode = 'production' WHERE id = $1", [releaseId])).not.toBe('ok');
    expect(await sql('DELETE FROM release WHERE id = $1', [releaseId])).not.toBe('ok');
    const row = (await st.db.pool.query('SELECT * FROM release WHERE id = $1', [releaseId])).rows[0];
    expect(await sql(
      `INSERT INTO release (candidate_id, approval_id, tender_id, stage_id, mode, input_version, content_hash, release_manifest_blob_sha256, release_manifest_sha256, gate, released_by)
       VALUES ($1, $2, $3, $4, 'test', 0, $5, $6, $7, '{}', $8)`,
      [c.id, approvalId, st.e.s.tenderA, st.e.s.stageA, c.contentHash, row.release_manifest_blob_sha256, row.release_manifest_sha256, st.e.s.ids.eng2],
    )).not.toBe('ok');
  });

  it('выпуск неготового кандидата и выпуск по согласованию другого кандидата отвергаются', async () => {
    const row = (await st.db.pool.query('SELECT * FROM release WHERE id = $1', [releaseId])).rows[0];
    expect(await sql(
      `INSERT INTO release (candidate_id, approval_id, tender_id, stage_id, mode, input_version, content_hash, release_manifest_blob_sha256, release_manifest_sha256, gate, released_by)
       VALUES ($1, $2, $3, $4, 'test', 0, $5, $6, $7, '{}', $8)`,
      [other.id, approvalId, st.e.s.tenderA, st.e.s.stageA, other.contentHash, row.release_manifest_blob_sha256, row.release_manifest_sha256, st.e.s.ids.eng1],
    )).not.toBe('ok');
  });
});

describe('принятие риска, удержания, возврат', () => {
  it('код и вид предмета согласованы; предмет — пункт этого кандидата; запись неизменна', async () => {
    expect(await sql(
      `INSERT INTO risk_acceptance (candidate_id, tender_id, stage_id, blocker_code, subject_type, subject_id, reason, accepted_by)
       VALUES ($1, $2, $3, 'REVIEW_UNCERTAIN', 'finding', $1, 'вид предмета не тот', $4)`,
      [other.id, st.e.s.tenderA, st.e.s.stageA, st.e.s.ids.manager],
    )).toBe('23514');
    expect(await sql(
      `INSERT INTO risk_acceptance (candidate_id, tender_id, stage_id, blocker_code, subject_type, subject_id, reason, accepted_by)
       VALUES ($1, $2, $3, 'NUMBERS_UNVERIFIED', 'candidate_check', $1, 'проверки с таким ID нет', $4)`,
      [other.id, st.e.s.tenderA, st.e.s.stageA, st.e.s.ids.manager],
    )).toBe('23514');
    const acc = (await st.db.pool.query('SELECT id FROM risk_acceptance WHERE candidate_id = $1 LIMIT 1', [c.id])).rows[0].id;
    expect(await sql("UPDATE risk_acceptance SET reason = 'другая причина риска' WHERE id = $1", [acc])).not.toBe('ok');
    // Принятие риска по выпущенному кандидату — нельзя.
    expect(await sql(
      `INSERT INTO risk_acceptance (candidate_id, tender_id, stage_id, blocker_code, subject_type, subject_id, reason, accepted_by)
       SELECT $1, $2, $3, 'NUMBERS_UNVERIFIED', 'candidate_check', k.id, 'после выпуска', $4 FROM candidate_check k WHERE k.candidate_id = $1 LIMIT 1`,
      [c.id, st.e.s.tenderA, st.e.s.stageA, st.e.s.ids.manager],
    )).not.toBe('ok');
  });

  it('удержание: решает руководитель решением по этому событию; решённое неизменно; решение по событию другого этапа отвергается', async () => {
    const hold = (await st.db.pool.query("SELECT id, input_event_id FROM readiness_hold WHERE candidate_id = $1 AND status <> 'open' LIMIT 1", [other.id])).rows[0];
    expect(hold).toBeTruthy();
    expect(await sql("UPDATE readiness_hold SET status = 'open', decision_id = NULL, resolved_by = NULL, resolved_at = NULL, row_version = row_version + 1 WHERE id = $1", [hold.id])).toBe('55000');
    const decide = (by: string, stage: string, event: string) =>
      sql(
        `INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by)
         VALUES ($1, $2, 'stage_input_event', $3, 'input_event_disposition', 'не влияет', 'проверка охранника', $4)`,
        [st.e.s.tenderA, stage, event, by],
      );
    expect(await decide(st.e.s.ids.eng1, st.e.s.stageA, hold.input_event_id)).toBe('42501');
    const eventB = (await st.db.pool.query('SELECT id FROM stage_input_event WHERE stage_id = $1 LIMIT 1', [st.e.s.stageB])).rows[0];
    if (eventB) expect(await decide(st.e.s.ids.manager, st.e.s.stageA, eventB.id)).toBe('23514');
    // Решение «не влияет» событий барьера не создаёт (R01-07).
    const before = Number((await st.db.pool.query('SELECT input_version FROM tender_stage WHERE id = $1', [st.e.s.stageA])).rows[0].input_version);
    expect(await decide(st.e.s.ids.manager, st.e.s.stageA, hold.input_event_id)).toBe('ok');
    expect(Number((await st.db.pool.query('SELECT input_version FROM tender_stage WHERE id = $1', [st.e.s.stageA])).rows[0].input_version)).toBe(before);
  });

  it('возврат — руководитель тендера, готовый или согласованный кандидат', async () => {
    expect(await sql('INSERT INTO candidate_return (candidate_id, tender_id, reason, returned_by) VALUES ($1, $2, $3, $4)', [other.id, st.e.s.tenderA, 'инженер возвращает', st.e.s.ids.eng1])).toBe('42501');
    expect(await sql('INSERT INTO candidate_return (candidate_id, tender_id, reason, returned_by) VALUES ($1, $2, $3, $4)', [c.id, st.e.s.tenderA, 'выпущенный не возвращается', st.e.s.ids.manager])).toBe('42501');
  });
});

// Последним: меняет вопросы и кандидатов этапа (вход прогона устаревает).
describe('отпечаток содержимого этапа (0035–0036, R13-01, R13-05)', () => {
  it('SQL stage_content_fingerprint_v2 совпадает с сервером и с закреплённым при запуске; каждое изменение записи входа меняет его; прежний v1 тоже совпадает с сервером', async () => {
    const scope = (await st.db.pool.query<{ s: string; r: string | null }>('SELECT evidence_scope_id AS s, registry_id AS r FROM review_run WHERE id = $1', [st.run.id])).rows[0]!;
    const same = async (registry: string | null): Promise<string> => {
      const js = await stageContentFingerprint(st.db.pool, st.e.s.stageA, registry, scope.s);
      const db = (await st.db.pool.query<{ f: string }>('SELECT stage_content_fingerprint_v2($1, $2, $3) AS f', [st.e.s.stageA, registry, scope.s])).rows[0]!.f;
      expect(db).toBe(js);
      const v1 = (await st.db.pool.query<{ f: string }>('SELECT stage_content_fingerprint($1, $2) AS f', [st.e.s.stageA, registry])).rows[0]!.f;
      expect(v1).toBe(await legacyStageContentFingerprint(st.db.pool, st.e.s.stageA, registry));
      return db;
    };
    const pinned = (await st.db.pool.query<{ f: string }>('SELECT content_fingerprint AS f FROM review_run_input WHERE run_id = $1', [st.run.id])).rows[0]!.f;
    expect(await same(st.registryId)).toBe(pinned);
    await same(null);
    // Два вопроса: первый — с большей версией; изменение второго (не максимума) меняет отпечаток (R13-05).
    const q1 = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/customer-questions`, { text: 'Вопрос 1 для отпечатка содержимого' }, { headers: idem() });
    const q2 = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/customer-questions`, { text: 'Вопрос 2 для отпечатка содержимого' }, { headers: idem() });
    expect([q1.status, q2.status]).toEqual([201, 201]);
    let etag = q1.headers.etag as string;
    for (let i = 0; i < 3; i += 1) etag = (await st.e.s.eng1.patch(`/customer-questions/${q1.body.id}`, { text: `Вопрос 1, вариант ${i}` }, { headers: { 'If-Match': etag } })).headers.etag as string;
    const before = await same(st.registryId);
    expect(before).not.toBe(pinned);
    const sent = await st.e.s.eng1.patch(`/customer-questions/${q2.body.id}`, { status: 'sent' }, { headers: { 'If-Match': q2.headers.etag as string } });
    expect(sent.status, sent.text).toBe(200);
    const afterSent = await same(st.registryId);
    expect(afterSent).not.toBe(before);
    // Кандидат требования без подтверждения — полнота реестра изменилась.
    const fragment = (await st.db.pool.query('SELECT id FROM evidence_fragment WHERE text = $1 ORDER BY id LIMIT 1', ['Окраска фасада выполняется в два слоя.'])).rows[0].id as string;
    const cand = await st.e.s.eng1.post(
      `/requirement-registries/${st.registryId}/requirement-candidates`,
      { statement: 'Кандидат для отпечатка содержимого', parameters: [], evidence: [{ fragmentId: fragment, role: 'supports' }] },
      { headers: idem() },
    );
    expect(cand.status, cand.text).toBe(201);
    expect(await same(st.registryId)).not.toBe(afterSent);
    // Не зависит от часового пояса сессии (в отпечатке нет времени).
    const tz = await st.db.pool.connect();
    try {
      await tz.query("SET TIME ZONE 'Asia/Almaty'");
      expect(await stageContentFingerprint(tz, st.e.s.stageA, st.registryId, scope.s)).toBe(await stageContentFingerprint(st.db.pool, st.e.s.stageA, st.registryId, scope.s));
    } finally {
      await tz.query('RESET TIME ZONE');
      tz.release();
    }
    // Комплект на этом прогоне теперь не согласуется и во второй линии.
    expect((await st.db.pool.query<{ p: string | null }>('SELECT candidate_gate_problem($1) AS p', [other.id])).rows[0]!.p).toBe('REVIEW_OUTDATED');
  });
});
