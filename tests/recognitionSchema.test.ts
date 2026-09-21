// Вторая линия защиты распознавания (миграция 0005): права роли приложения и триггеры.
// Проверяется то, что должно держаться и при ошибке в коде портала: прогон после
// терминального статуса неизменен, страницы и фрагменты неизменяемы, переходы ограничены,
// заморозка набора требует распознавания.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, seedRecognition, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let s: IScenario;
const config = testConfig();
const revs: string[] = [];

const newBlob = async (): Promise<string> => {
  const sha = randomBytes(32).toString('hex');
  await db.pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, 'application/zip', $2)", [sha, `t/${sha}`]);
  return sha;
};

const newRun = async (revisionId: string, tenderId: string, extra: { supersedes?: string } = {}): Promise<string> => {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, supersedes_run_id)
     VALUES ($1, $2, 'rdweb_export', $3, $4) RETURNING id`,
    [revisionId, tenderId, await newBlob(), extra.supersedes ?? null],
  );
  return r.rows[0]!.id;
};

beforeAll(async () => {
  db = await createTestDb();
  const app = makeApp(db, undefined, config);
  s = await buildScenario(db, app);
  for (const [stage, name, client] of [
    [s.stageA, 'ТЗ.pdf', 'eng1'],
    [s.stageA, 'ПД.pdf', 'eng1'],
    [s.stageB, 'Чужой.pdf', 'eng3'],
  ] as const) {
    const c = client === 'eng1' ? s.eng1 : s.eng3;
    const r = await c.post(`/stages/${stage}/imports?name=${encodeURIComponent(name)}`, fakePdf(name), {
      headers: { 'Content-Type': 'application/octet-stream', ...idem() },
    });
    await drain(makeWorker(db, config));
    revs.push((await c.get(`/imports/${r.body.id}`)).body.items[0].documentRevisionId);
  }
});
afterAll(async () => db.drop());

describe('схема распознавания: права и триггеры', () => {
  it('прогон создаётся только в queued и только с предшественником той же редакции', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, status, pages_total, pages_recognized, finished_at)
         VALUES ($1, $2, 'rdweb_export', $3, 'complete', 1, 1, now())`,
        [revs[0], s.tenderA, await newBlob()],
      ),
    ).rejects.toThrow(/создаётся в состоянии queued/);

    const foreignRun = await seedRecognition(db.pool, revs[2]!);
    await expect(newRun(revs[0]!, s.tenderA, { supersedes: foreignRun })).rejects.toThrow(/предшественник/);

    const queued = await newRun(revs[0]!, s.tenderA);
    await expect(newRun(revs[0]!, s.tenderA, { supersedes: queued })).rejects.toThrow(/предшественник/);
  });

  it('редакция чужого тендера не попадает в прогон (составной внешний ключ)', async () => {
    await expect(newRun(revs[2]!, s.tenderA)).rejects.toThrow(/recognition_run_revision_tender_fk|violates foreign key/i);
  });

  it('переходы статуса ограничены, завершённый прогон неизменен', async () => {
    const id = await newRun(revs[1]!, s.tenderA);
    await expect(
      db.pool.query(
        "UPDATE recognition_run SET status = 'complete', pages_total = 1, pages_recognized = 1, finished_at = now(), row_version = row_version + 1 WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/недопустимый переход/);

    await db.pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [id]);
    // Полнота не декларируется без подтверждения: complete с нехваткой страниц — нарушение CHECK (I18).
    await expect(
      db.pool.query(
        "UPDATE recognition_run SET status = 'complete', pages_total = 3, pages_recognized = 2, finished_at = now(), row_version = row_version + 1 WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/recognition_run_complete_shape/);

    await db.pool.query(
      "UPDATE recognition_run SET status = 'partial', pages_total = 3, pages_recognized = 2, finished_at = now(), row_version = row_version + 1 WHERE id = $1",
      [id],
    );
    await expect(db.pool.query("UPDATE recognition_run SET quality = '{}'::jsonb, row_version = row_version + 1 WHERE id = $1", [id])).rejects.toThrow(
      /frozen-after/,
    );
    await expect(db.pool.query('DELETE FROM recognition_run WHERE id = $1', [id])).rejects.toThrow(/удаление запрещено|permission denied/i);
  });

  it('источник прогона неизменен, row_version растёт на 1', async () => {
    const id = await newRun(revs[1]!, s.tenderA);
    await expect(
      db.pool.query('UPDATE recognition_run SET source_artifact_sha256 = $2, row_version = row_version + 1 WHERE id = $1', [id, await newBlob()]),
    ).rejects.toThrow(/неизменяемы/);
    await expect(db.pool.query("UPDATE recognition_run SET status = 'running', started_at = now() WHERE id = $1", [id])).rejects.toThrow(
      /row_version/,
    );
  });

  it('одна пара «редакция + архив» — один прогон, после failed повтор разрешён', async () => {
    const sha = await newBlob();
    const insert = () =>
      db.pool.query<{ id: string }>(
        `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256)
         VALUES ($1, $2, 'rdweb_export', $3) RETURNING id`,
        [revs[0], s.tenderA, sha],
      );
    const first = (await insert()).rows[0]!.id;
    await expect(insert()).rejects.toThrow(/recognition_run_artifact_key/);
    await db.pool.query(
      "UPDATE recognition_run SET status = 'failed', failure_code = 'test', finished_at = now(), row_version = row_version + 1 WHERE id = $1",
      [first],
    );
    await expect(insert()).resolves.toBeTruthy();
  });

  it('страницы и фрагменты неизменяемы, форма координат проверяется', async () => {
    const run = await newRun(revs[1]!, s.tenderA);
    await db.pool.query(
      "INSERT INTO recognition_page (run_id, page_index, page_label, width_px, height_px, rotation, status) VALUES ($1, 0, '1', 100, 200, 90, 'recognized')",
      [run],
    );
    await expect(
      db.pool.query("INSERT INTO recognition_page (run_id, page_index, status) VALUES ($1, 0, 'missing')", [run]),
    ).rejects.toThrow(/recognition_page_key/);
    await expect(db.pool.query("UPDATE recognition_page SET status = 'missing' WHERE run_id = $1", [run])).rejects.toThrow(
      /immutable|permission denied/i,
    );
    await expect(db.pool.query('DELETE FROM recognition_page WHERE run_id = $1', [run])).rejects.toThrow(/immutable|permission denied/i);

    const frag = (values: string, params: unknown[]) =>
      db.pool.query(
        `INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, run_id, document_revision_id, ${values}`,
        params,
      );
    await expect(
      frag("origin, fragment_kind, fragment_key, page_index, bbox_norm, bbox_space, text, text_sha256) VALUES ($1, 'recognition_run', $2, $2, $3, 'recognized_text', 'text_block', 'k1', 0, $4::numeric[], 'page_rotated', 'x', $5)", [
        s.tenderA,
        run,
        revs[1],
        [0.1, 0.2, 0.3, 0.4, 0.5],
        'a'.repeat(64).replace(/a/g, '0'),
      ]),
    ).rejects.toThrow(/bbox_norm/);

    // Описание модели обязано называть источник производности: иначе оно неотличимо от текста (I06).
    await expect(
      frag("origin, fragment_kind, fragment_key, text, text_sha256) VALUES ($1, 'recognition_run', $2, $2, $3, 'model_description', 'summary', 'k2', 'x', $4)", [
        s.tenderA,
        run,
        revs[1],
        '0'.repeat(64),
      ]),
    ).rejects.toThrow(/evidence_fragment_derived_shape/);

    await frag("origin, fragment_kind, fragment_key, page_index, text, text_sha256) VALUES ($1, 'recognition_run', $2, $2, $3, 'recognized_text', 'text_block', 'k3', 0, 'x', $4)", [
      s.tenderA,
      run,
      revs[1],
      '0'.repeat(64),
    ]);
    await expect(db.pool.query("UPDATE evidence_fragment SET text = 'y' WHERE run_id = $1", [run])).rejects.toThrow(/immutable|permission denied/i);
    await expect(db.pool.query('DELETE FROM evidence_fragment WHERE run_id = $1', [run])).rejects.toThrow(/immutable|permission denied/i);
  });

  it('фрагмент чужого тендера не привязывается к прогону (составной внешний ключ)', async () => {
    const run = await newRun(revs[1]!, s.tenderA);
    await expect(
      db.pool.query(
        `INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, run_id, document_revision_id, origin, fragment_kind, fragment_key, text, text_sha256)
         VALUES ($1, 'recognition_run', $2, $2, $3, 'recognized_text', 'text_block', 'x1', 'x', $4)`,
        [s.tenderB, run, revs[1], '0'.repeat(64)],
      ),
    ).rejects.toThrow(/evidence_fragment_run_tender_fk|violates foreign key/i);
  });

  it('заморозка набора требует распознавания включённых редакций', async () => {
    const d = await s.eng1.post(`/stages/${s.stageA}/source-set-revisions`, {}, { headers: idem() });
    await s.eng1.put(
      `/source-set-revisions/${d.body.id}/items`,
      { items: [{ documentRevisionId: revs[0], inclusion: 'included' }, { documentRevisionId: revs[1], inclusion: 'excluded_not_applicable', reason: 'другой лот' }] },
      { headers: { 'If-Match': d.headers.etag } },
    );
    const freeze = () =>
      db.pool.query("UPDATE source_set_revision SET status = 'frozen', frozen_at = now(), frozen_by = $2, content_hash = 'h', row_version = row_version + 1 WHERE id = $1", [
        d.body.id,
        s.ids.eng1,
      ]);
    await expect(freeze()).rejects.toThrow(/нет завершённого или частичного распознавания/);
    // Явно неполное распознавание заморозку разрешает: неполнота видна, но вход доказуем.
    await seedRecognition(db.pool, revs[0]!, 'partial', { total: 3, recognized: 2 });
    await expect(freeze()).resolves.toBeTruthy();
  });
});
