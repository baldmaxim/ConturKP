// Регрессии по ревью 04-1 (docs/reviews/04-review-1.md): R04-04 и R04-05 — вторая линия БД.
// Проверяется то, что обязано держаться и при ошибке в коде портала.
//
// R04-04 — терминальный прогон неизменяем целиком, а не только заголовком: дочерние строки
//          принимает лишь выполняющийся прогон, а счётчики полноты сверяются с фактом.
// R04-05 — фрагмент-доказательство связан с редакцией своего прогона составным ключом:
//          межтендерная подмена ссылки невозможна на уровне схемы.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { fakePdf } from './zip.ts';

let db: ITestDb;
let s: IScenario;
const config = testConfig();
const revs: string[] = [];

const newBlob = async (): Promise<string> => {
  const sha = randomBytes(32).toString('hex');
  await db.pool.query("INSERT INTO blob (sha256, size_bytes, media_type, storage_key) VALUES ($1, 1, 'application/zip', $2)", [sha, `r04b/${sha}`]);
  return sha;
};

// Прогон в заданном состоянии. Страницы вставляются, пока прогон выполняется, — иначе
// терминализация не сойдётся со счётчиками (R04-04).
const newRun = async (revisionId: string, tenderId: string, start = true): Promise<string> => {
  // Один незавершённый прогон на редакцию (R04-12): прежняя попытка закрывается отменой.
  await db.pool.query(
    `UPDATE recognition_run SET status = 'cancelled', finished_at = now(), row_version = row_version + 1
      WHERE document_revision_id = $1 AND status IN ('queued', 'running')`,
    [revisionId],
  );
  // Новый прогон встаёт за хвостом истории редакции (R04-12).
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO recognition_run (document_revision_id, tender_id, engine, source_artifact_sha256, supersedes_run_id)
     VALUES ($1, $2, 'rdweb_export', $3, (SELECT p.id FROM recognition_run p
       WHERE p.document_revision_id = $1 AND p.status IN ('complete', 'partial')
         AND NOT EXISTS (SELECT 1 FROM recognition_run c WHERE c.supersedes_run_id = p.id AND c.status NOT IN ('failed', 'cancelled'))
       ORDER BY p.created_at DESC LIMIT 1)) RETURNING id`,
    [revisionId, tenderId, await newBlob()],
  );
  const id = r.rows[0]!.id;
  if (start) await db.pool.query("UPDATE recognition_run SET status = 'running', started_at = now(), row_version = row_version + 1 WHERE id = $1", [id]);
  return id;
};

const addPage = (runId: string, pageIndex: number, status: 'recognized' | 'missing' = 'recognized') =>
  db.pool.query(
    'INSERT INTO recognition_page (run_id, page_index, width_px, height_px, status) VALUES ($1, $2, $3, $4, $5)',
    [runId, pageIndex, status === 'recognized' ? 100 : null, status === 'recognized' ? 200 : null, status],
  );

const addFragment = (runId: string, tenderId: string, revisionId: string, key = 'k1') =>
  db.pool.query(
    `INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, run_id, document_revision_id,
       origin, fragment_kind, fragment_key, text, text_sha256)
     VALUES ($1, 'recognition_run', $2, $2, $3, 'recognized_text', 'text_block', $4, 'x', $5)`,
    [tenderId, runId, revisionId, key, '0'.repeat(64)],
  );

const finish = (runId: string, status: 'complete' | 'partial', total: number, recognized: number) =>
  db.pool.query(
    `UPDATE recognition_run SET status = $2, engine_schema_version = '1', pages_total = $3, pages_recognized = $4,
            finished_at = now(), row_version = row_version + 1 WHERE id = $1`,
    [runId, status, total, recognized],
  );

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

describe('R04-04: терминальный прогон — неизменяемый агрегат доказательств', () => {
  it('страницу и фрагмент нельзя добавить в прогон, который ещё не выполняется', async () => {
    const queued = await newRun(revs[0]!, s.tenderA, false);
    await expect(addPage(queued, 0)).rejects.toThrow(/только в выполняющийся прогон \(статус queued\)/);
    await expect(addFragment(queued, s.tenderA, revs[0]!)).rejects.toThrow(/только в выполняющийся прогон \(статус queued\)/);
  });

  it('страницу и фрагмент нельзя добавить в завершённый прогон', async () => {
    const run = await newRun(revs[0]!, s.tenderA);
    await addPage(run, 0);
    await addPage(run, 1, 'missing');
    await addFragment(run, s.tenderA, revs[0]!);
    expect((await finish(run, 'partial', 2, 1)).rowCount).toBe(1);

    await expect(addPage(run, 2)).rejects.toThrow(/только в выполняющийся прогон \(статус partial\)/);
    await expect(addFragment(run, s.tenderA, revs[0]!, 'k2')).rejects.toThrow(/только в выполняющийся прогон \(статус partial\)/);
  });

  it('complete нельзя объявить по числам, не подтверждённым строками страниц', async () => {
    const run = await newRun(revs[1]!, s.tenderA);
    await expect(finish(run, 'complete', 3, 3)).rejects.toThrow(/pages_total = 3 при 0 фактических страницах/);
  });

  it('partial нельзя объявить, если строки страниц не соответствуют счётчикам', async () => {
    const run = await newRun(revs[1]!, s.tenderA);
    await addPage(run, 0);
    await addPage(run, 1);
    await addPage(run, 2);
    // Фактически распознаны все три, а заявлены две.
    await expect(finish(run, 'partial', 3, 2)).rejects.toThrow(/pages_recognized = 2 при 3 распознанных страницах/);
    // И наоборот: число страниц заявлено больше фактического.
    await expect(finish(run, 'partial', 4, 3)).rejects.toThrow(/pages_total = 4 при 3 фактических страницах/);
  });

  it('штатный порядок «вставка страниц и фрагментов → терминализация» работает', async () => {
    const run = await newRun(revs[1]!, s.tenderA);
    await addPage(run, 0);
    await addPage(run, 1);
    await addPage(run, 2, 'missing');
    await addFragment(run, s.tenderA, revs[1]!);
    expect((await finish(run, 'partial', 3, 2)).rowCount).toBe(1);
    const row = await db.pool.query<{ status: string }>('SELECT status FROM recognition_run WHERE id = $1', [run]);
    expect(row.rows[0]!.status).toBe('partial');
  });
});

describe('R04-05: фрагмент принадлежит редакции своего прогона', () => {
  it('прогон тендера A и редакция тендера B в одном фрагменте не сходятся', async () => {
    const run = await newRun(revs[0]!, s.tenderA);
    await expect(addFragment(run, s.tenderA, revs[2]!)).rejects.toThrow(/evidence_fragment_run_revision_tender_fk|violates foreign key/i);
  });

  it('другая редакция того же тендера тоже не подставляется', async () => {
    const run = await newRun(revs[0]!, s.tenderA);
    await expect(addFragment(run, s.tenderA, revs[1]!)).rejects.toThrow(/evidence_fragment_run_revision_tender_fk|violates foreign key/i);
  });

  it('прогонный фрагмент без редакции не создаётся: иначе составной ключ не проверялся бы', async () => {
    const run = await newRun(revs[0]!, s.tenderA);
    await expect(
      db.pool.query(
        `INSERT INTO evidence_fragment (tender_id, source_unit_type, source_unit_id, run_id, document_revision_id,
           origin, fragment_kind, fragment_key, text, text_sha256)
         VALUES ($1, 'recognition_run', $2, $2, NULL, 'recognized_text', 'text_block', 'k-null', 'x', $3)`,
        [s.tenderA, run, '0'.repeat(64)],
      ),
    ).rejects.toThrow(/evidence_fragment_revision_shape/);
  });

  it('верная связка «прогон — редакция — тендер» проходит, и доказательство ссылается на свою редакцию', async () => {
    const run = await newRun(revs[0]!, s.tenderA);
    await addPage(run, 0);
    await addFragment(run, s.tenderA, revs[0]!, 'ok-1');
    await finish(run, 'complete', 1, 1);

    const frag = await db.pool.query<{ id: string }>('SELECT id FROM evidence_fragment WHERE run_id = $1 AND fragment_key = $2', [run, 'ok-1']);
    const evidence = await s.eng1.get(`/evidence/${frag.rows[0]!.id}`);
    expect(evidence.status, evidence.text).toBe(200);
    // Метаданные доказательства взяты у редакции собственного прогона, а не у чужой.
    expect(evidence.body.documentRevisionId).toBe(revs[0]);
    expect(evidence.body.contentUrl).toBe(`/api/v1/document-revisions/${revs[0]}/content`);
  });
});
