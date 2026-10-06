// Этап 12 — вторая линия БД 0032 (D-032; проект §10): прямые записи роли kontur_app в обход API. Кандидат: создатель
// с candidate.create, входы этапа, неизменные режим, входы и базы, готовый — с файлами и без проваленных проверок; входы —
// только в транзакции создания; файлы и проверки — только пока «собирается»; ревизия шаблона с ошибками разметки не
// утверждается; вложение готовит тот, кто ведёт шаблоны; удаление запрещено.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEcon, closeEcon, type IEcon } from './economicsFixtures.ts';
import { createTestDb, testConfig, type ITestDb } from './helpers.ts';
import { fixScope, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let e: IEcon;
let scopeId = '';
let blobSha = '';

const q = async (sql: string, params: unknown[] = []): Promise<string> => db.pool.query(sql, params).then(() => 'ok', (x: { code?: string }) => x.code ?? 'error');

const tx = async (fn: (c: pg.PoolClient) => Promise<unknown>): Promise<string> => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
    return 'ok';
  } catch (x) {
    await c.query('ROLLBACK').catch(() => undefined);
    return (x as { code?: string }).code ?? 'error';
  } finally {
    c.release();
  }
};

const insertCandidate = (c: pg.PoolClient | pg.Pool, userId: string, calc = e.rev2) =>
  c.query<{ id: string }>(
    `INSERT INTO release_candidate (tender_id, stage_id, seq, mode, calculation_revision_id, evidence_scope_id, calculation_baseline_version, content_baseline_version, inputs_sha256, created_by)
     VALUES ($1, $2, (SELECT coalesce(max(seq), 0) + 1 FROM release_candidate WHERE stage_id = $2), 'test', $3, $4, 0, 0, repeat('a', 64), $5) RETURNING id`,
    [e.s.tenderA, e.s.stageA, calc, scopeId, userId],
  );

// Один «собирается» на этап: прежний переводится в «сборка не удалась» перед новой вставкой.
const clearAssembling = () =>
  db.pool.query("UPDATE release_candidate SET status = 'assembly_failed', failure_code = 'x', failure_detail = 'очистка', finished_at = now(), row_version = row_version + 1 WHERE status = 'assembling'");

beforeAll(async () => {
  db = await createTestDb();
  e = await buildEcon(db, testConfig());
  const doc = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, 'ТЗ.pdf');
  await seedEvidenceRun(db.pool, doc, { pages: [{ blocks: ['Техническое задание.'] }] });
  await setWorkingSet(e.s.manager, e.s.stageA, [doc], true);
  scopeId = await fixScope(e.s.manager, e.s.stageA);
  blobSha = (await db.pool.query<{ sha256: string }>('SELECT sha256 FROM blob ORDER BY created_at LIMIT 1')).rows[0]!.sha256;
});
afterAll(async () => {
  await closeEcon(e);
  await db.drop();
});

describe('вторая линия 0032 — кандидат', () => {
  it('создатель — участник тендера с candidate.create; ревизия расчёта и снимок — этого этапа', async () => {
    expect(await tx((c) => insertCandidate(c, e.s.ids.eng3))).toBe('42501');
    expect(await tx((c) => insertCandidate(c, e.s.ids.admin))).toBe('42501');
    const other = (await db.pool.query<{ id: string }>('SELECT id FROM calculation_revision WHERE stage_id <> $1 LIMIT 1', [e.s.stageA])).rows[0]?.id;
    if (other) expect(await tx((c) => insertCandidate(c, e.s.ids.eng1, other))).not.toBe('ok');
    expect(await tx((c) => insertCandidate(c, e.s.ids.eng1))).toBe('ok');
  });

  it('режим, входы и базы неизменны; переход «собирается» → «готов» — только с манифестом и файлами; удаление запрещено', async () => {
    await clearAssembling();
    const id = (await insertCandidate(db.pool, e.s.ids.eng1)).rows[0]!.id;
    expect(await q("UPDATE release_candidate SET mode = 'production', row_version = row_version + 1 WHERE id = $1", [id])).toBe('55000');
    expect(await q('UPDATE release_candidate SET content_baseline_version = 1, row_version = row_version + 1 WHERE id = $1', [id])).toBe('55000');
    expect(
      await q(
        `UPDATE release_candidate SET status = 'ready_for_approval', manifest_blob_sha256 = $2, manifest_sha256 = repeat('b', 64), converter_version = 'LibreOffice', finished_at = now(),
                row_version = row_version + 1 WHERE id = $1`,
        [id, blobSha],
      ),
    ).toBe('23514');
    expect(await q('DELETE FROM release_candidate WHERE id = $1', [id])).not.toBe('ok');
    expect(await q("UPDATE release_candidate SET status = 'assembly_failed', failure_code = 'x', failure_detail = 'проверка', finished_at = now(), row_version = row_version + 1 WHERE id = $1", [id])).toBe('ok');
    expect(await q("UPDATE release_candidate SET status = 'ready_for_approval', row_version = row_version + 1 WHERE id = $1", [id])).not.toBe('ok');
  });

  it('входы — только в транзакции создания; файлы и проверки — только пока «собирается»; готовый — без проваленных проверок', async () => {
    await clearAssembling();
    const id = (await insertCandidate(db.pool, e.s.ids.eng1)).rows[0]!.id;
    const run = (await db.pool.query<{ id: string }>('SELECT id FROM decision LIMIT 1')).rows[0]?.id ?? id;
    expect(await q("INSERT INTO candidate_input (candidate_id, kind, ref_id, ordinal) VALUES ($1, 'decision', $2, 0)", [id, run])).toBe('55000');
    expect(await q("INSERT INTO candidate_check (candidate_id, ordinal, code, outcome) VALUES ($1, 1, 'render_complete', 'failed')", [id])).toBe('ok');
    // Файл без входа-шаблона, превью без исходного — отказ формы и происхождения.
    expect(await q("INSERT INTO candidate_file (candidate_id, ordinal, path, role, audience, media_type, blob_sha256, size_bytes) VALUES ($1, 1, 'a.docx', 'document', 'customer', 'x/y', $2, 1)", [id, blobSha])).not.toBe('ok');
    const fail = await tx(async (c) => {
      await c.query(
        `UPDATE release_candidate SET status = 'ready_for_approval', manifest_blob_sha256 = $2, manifest_sha256 = repeat('b', 64), converter_version = 'LibreOffice', finished_at = now(),
                row_version = row_version + 1 WHERE id = $1`,
        [id, blobSha],
      );
    });
    expect(fail).toBe('23514');
    await q("UPDATE release_candidate SET status = 'assembly_failed', failure_code = 'render_complete', failure_detail = 'проверка', finished_at = now(), row_version = row_version + 1 WHERE id = $1", [id]);
    expect(await q("INSERT INTO candidate_check (candidate_id, ordinal, code, outcome) VALUES ($1, 2, 'hashes', 'passed')", [id])).toBe('55000');
    expect(await q('UPDATE candidate_check SET outcome = $2 WHERE candidate_id = $1', [id, 'passed'])).not.toBe('ok');
  });

  it('два кандидата «собирается» на этапе одновременно — нельзя', async () => {
    await clearAssembling();
    expect(await tx((c) => insertCandidate(c, e.s.ids.eng1))).toBe('ok');
    expect(await tx((c) => insertCandidate(c, e.s.ids.eng1))).toBe('23505');
  });
});

describe('вторая линия 0032 — вложения', () => {
  it('вложение и ревизию готовит тот, кто ведёт шаблоны; содержание ревизии неизменно', async () => {
    expect(await q("INSERT INTO standard_attachment (title, created_by) VALUES ('Руководство', $1)", [e.s.ids.eng1])).toBe('42501');
    const a = (await db.pool.query<{ id: string }>("INSERT INTO standard_attachment (title, created_by) VALUES ('Руководство', $1) RETURNING id", [e.s.ids.manager])).rows[0]!.id;
    expect(
      await q("INSERT INTO standard_attachment_revision (attachment_id, seq, blob_sha256, file_name, media_type, audience, created_by) VALUES ($1, 1, $2, 'a.pdf', 'application/pdf', 'customer', $3)", [a, blobSha, e.s.ids.eng1]),
    ).toBe('42501');
    const r = (await db.pool.query<{ id: string }>(
      "INSERT INTO standard_attachment_revision (attachment_id, seq, blob_sha256, file_name, media_type, audience, created_by) VALUES ($1, 1, $2, 'a.pdf', 'application/pdf', 'customer', $3) RETURNING id",
      [a, blobSha, e.s.ids.manager],
    )).rows[0]!.id;
    expect(await q("UPDATE standard_attachment_revision SET file_name = 'b.pdf', row_version = row_version + 1 WHERE id = $1", [r])).toBe('55000');
    expect(await q("UPDATE standard_attachment_revision SET status = 'approved', approved_by = $2, approved_at = now(), row_version = row_version + 1 WHERE id = $1", [r, e.s.ids.eng1])).toBe('42501');
    expect(await q("UPDATE standard_attachment_revision SET status = 'approved', approved_by = $2, approved_at = now(), row_version = row_version + 1 WHERE id = $1", [r, e.s.ids.manager])).toBe('ok');
  });
});
