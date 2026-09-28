// Поиск портала, лексические ветки (этап 05; ADR-008, ADR-012, state-machines §20–21). Корпус —
// только прогоны распознавания RDWeb (AR05-05). Модель эмбеддингов не настроена: версия индекса
// строится без векторов, смысловая ветка честно недоступна с причиной, итог — по {exact, fts}.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHUNKER_VERSION } from '../packages/core/src/index.ts';
import {
  createVersion,
  ftsBranch,
  getActiveVersion,
  loadAccessContext,
  queryLexemes,
  unitsNotPermitted,
} from '../packages/db/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { auditRows, buildScenario, createTestDb, drain, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { buildRdwebExport } from './rdweb.ts';
import { buildIndex, fixScope, fragmentIdOf, reviewBody, searchBody, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

let db: ITestDb;
let s: IScenario;
let worker: WorkerRuntime;
const config = testConfig();
const ids: Record<string, string> = {};

const FACADE = 'Фасад облицовывается керамогранитом толщиной 10 мм';

beforeAll(async () => {
  db = await createTestDb();
  s = await buildScenario(db, makeApp(db, undefined, config));
  worker = makeWorker(db, config);
  const stageA2 = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: 'Этап A2' }, { headers: idem() });
  expect(stageA2.status, stageA2.text).toBe(201);
  ids.stageA2 = stageA2.body.id;

  // Тендер A, этап A1: ТЗ с фасадом и кровлей; спецификация с той же фразой в состав НЕ входит.
  ids.revTz = await uploadDocument(db, config, s.eng1, s.stageA, 'ТЗ-A.pdf');
  ids.runTz = await seedEvidenceRun(db.pool, ids.revTz!, {
    pages: [
      {
        stamp: 'Шифр АР-01 · Лист 1 · Архитектурные решения',
        blocks: [
          FACADE,
          'Кровля плоская, утеплитель минераловатный 200 мм',
          { text: 'Уникальноеописаниесхемы узла примыкания', origin: 'model_description' },
        ],
      },
      { blocks: ['Окна двухкамерные в алюминиевом профиле'] },
    ],
    unpaged: ['Примечание без страницы: гидроизоляция обмазочная'],
  });
  ids.revSpec = await uploadDocument(db, config, s.eng1, s.stageA, 'Спецификация-A.pdf');
  ids.runSpec = await seedEvidenceRun(db.pool, ids.revSpec!, { pages: [{ blocks: [`${FACADE} по спецификации`] }] });

  // Один PDF, два прогона: поздний (R2) содержит больше слов запроса и ранжируется выше.
  ids.revKj = await uploadDocument(db, config, s.eng1, s.stageA, 'КЖ-A.pdf');
  ids.runKj1 = await seedEvidenceRun(db.pool, ids.revKj!, { pages: [{ blocks: ['Бетон класса B25 для фундаментов'] }] });

  // Этап A2 того же тендера: противоположный ответ про фасад.
  ids.revA2 = await uploadDocument(db, config, s.eng1, ids.stageA2!, 'ТЗ-A2.pdf');
  ids.runA2 = await seedEvidenceRun(db.pool, ids.revA2!, { pages: [{ blocks: ['Фасад облицовывается штукатуркой по утеплителю'] }] });

  // Тендер B: та же фраза, что в тендере A.
  ids.revB = await uploadDocument(db, config, s.eng3, s.stageB, 'ТЗ-B.pdf');
  ids.runB = await seedEvidenceRun(db.pool, ids.revB!, { pages: [{ blocks: [FACADE] }] });

  await setWorkingSet(s.eng1, s.stageA, [ids.revTz!, ids.revKj!], true);
  await setWorkingSet(s.eng1, ids.stageA2!, [ids.revA2!]);
  await setWorkingSet(s.eng3, s.stageB, [ids.revB!]);
  // Снимок E1: этап A1, когда у КЖ был только R1.
  ids.scopeE1 = await fixScope(s.eng1, s.stageA);
});
afterAll(async () => db.drop());

const post = (body: unknown, client = s.eng1) => client.post('/search', body);
const fusedIds = (body: { fused: { items: { fragmentId: string }[] } | null }): string[] => (body.fused?.items ?? []).map((i) => i.fragmentId);

describe('индекс ещё не построен (G05-03)', () => {
  it('POST /search без активной версии — 409 search_index_not_ready, прогон не создаётся', async () => {
    const r = await post(searchBody(s.tenderA, s.stageA, 'фасад'));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toMatchObject({ code: 'STATE_CONFLICT', current: { reason: 'search_index_not_ready' } });
    const runs = await db.pool.query('SELECT count(*)::int AS n FROM search_run');
    expect(runs.rows[0].n).toBe(0);
  });
});

describe('версия индекса строится проходом обслуживания и заданиями', () => {
  it('первая версия без модели: текстовая, активируется после полноты', async () => {
    const versionId = await buildIndex(db, worker);
    const v = await getActiveVersion(db.pool);
    expect(v?.id).toBe(versionId);
    expect(v).toMatchObject({ status: 'active', chunker_version: CHUNKER_VERSION, embedding_model: null, embedding_dim: null });
    const units = await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM search_index_unit WHERE index_version_id = $1', [versionId]);
    const runs = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM recognition_run WHERE status IN ('complete', 'partial')");
    expect(units.rows[0]!.n).toBe(runs.rows[0]!.n);
  });

  it('описание модели не индексируется: skipped/origin_not_evidence, в связях чанков его нет (I06)', async () => {
    const f = await fragmentIdOf(db.pool, ids.runTz!, 'Уникальноеописаниесхемы узла примыкания');
    const state = await db.pool.query('SELECT status, skip_reason FROM fragment_index_state WHERE fragment_id = $1', [f]);
    expect(state.rows).toEqual([{ status: 'skipped', skip_reason: 'origin_not_evidence' }]);
    const links = await db.pool.query('SELECT 1 FROM search_chunk_fragment WHERE fragment_id = $1', [f]);
    expect(links.rowCount).toBe(0);
  });
});

describe('поиск по рабочему составу этапа', () => {
  it('без модели: degraded с причиной, итог по точной и полнотекстовой веткам, цитата — фрагмент портала', async () => {
    const r = await post(searchBody(s.tenderA, s.stageA, 'чем облицовывается фасад'));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({
      status: 'degraded',
      semantic: { status: 'unavailable', reason: 'index_without_embeddings' },
      lexical: null,
      rankingVersion: 'r1',
      context: { kind: 'tender', mode: 'working', stageId: s.stageA },
    });
    expect(r.body.scopeHash).toMatch(/^[0-9a-f]{64}$/);
    const top = r.body.fused.items[0];
    expect(top).toMatchObject({ fragmentId: await fragmentIdOf(db.pool, ids.runTz!, FACADE), origin: 'recognized_text', documentRevisionId: ids.revTz, pageIndex: 0, pageLabel: '1' });
    expect(top.matchedVia).toContain('fts');
    // Предварительного результата у терминального прогона нет; итог хранится в прогоне.
    const again = await s.eng1.get(`/search-runs/${r.body.searchRunId}`);
    expect(again.status).toBe(200);
    expect(fusedIds(again.body)).toEqual(fusedIds(r.body));
  });

  it('два тендера с одинаковой фразой: утечка ноль — ни фрагментов, ни счётчиков чужого тендера (A12)', async () => {
    const r = await post(searchBody(s.tenderA, s.stageA, FACADE, 50));
    expect(r.status).toBe(200);
    const runs = r.body.fused.items.map((i: { recognitionRunId: string }) => i.recognitionRunId);
    expect(runs).not.toContain(ids.runB);
    expect(r.body.scope.units).toBe(2);
    const rb = await post(searchBody(s.tenderB, s.stageB, FACADE, 50), s.eng3);
    expect(rb.body.fused.items.map((i: { recognitionRunId: string }) => i.recognitionRunId)).toEqual([ids.runB]);
    // Инженер тендера B не видит тендер A ни поиском, ни прогоном по ID.
    const denied = await post(searchBody(s.tenderA, s.stageA, FACADE), s.eng3);
    expect(denied.status).toBe(404);
    expect(denied.body.scope).toBeUndefined();
    const foreign = await s.eng3.get(`/search-runs/${r.body.searchRunId}`);
    expect(foreign.status).toBe(404);
  });

  it('две единицы одного тендера, в области одна: фрагменты невключённой не участвуют', async () => {
    const r = await post(searchBody(s.tenderA, s.stageA, `${FACADE} по спецификации`, 50));
    const runs = new Set(r.body.fused.items.map((i: { recognitionRunId: string }) => i.recognitionRunId));
    expect(runs.has(ids.runSpec)).toBe(false);
    expect(runs.has(ids.runTz)).toBe(true);
  });

  it('два этапа с противоположными ответами: каждый этап отвечает своим составом', async () => {
    const a1 = await post(searchBody(s.tenderA, s.stageA, 'чем облицовывается фасад'));
    const a2 = await post(searchBody(s.tenderA, ids.stageA2!, 'чем облицовывается фасад'));
    expect(a1.body.fused.items[0].text).toContain('керамогранитом');
    expect(a2.body.fused.items.map((i: { text: string }) => i.text)).toEqual(['Фасад облицовывается штукатуркой по утеплителю']);
  });

  it('точная ветка: обозначение из шапки листа и латиница/кириллица в коде совпадают', async () => {
    const r = await post(searchBody(s.tenderA, s.stageA, 'АР-01'));
    const top = r.body.fused.items[0];
    expect(top.matchedVia).toContain('exact');
    expect(top.fragmentKind).toBe('stamp_block');
    const b25 = await post(searchBody(s.tenderA, s.stageA, 'В25'));
    expect(b25.body.fused.items[0].text).toBe('Бетон класса B25 для фундаментов');
    expect(b25.body.fused.items[0].matchedVia).toContain('exact');
  });

  it('фрагмент без страницы находится и честно показывает отсутствие страницы', async () => {
    const r = await post(searchBody(s.tenderA, s.stageA, 'гидроизоляция обмазочная'));
    expect(r.body.fused.items[0]).toMatchObject({ text: 'Примечание без страницы: гидроизоляция обмазочная', pageIndex: null });
  });

  it('описание модели не находится ни одной веткой; пустой итог — «не найдено в области», а не «не предусмотрено» (I06, I07)', async () => {
    const r = await post(searchBody(s.tenderA, s.stageA, 'Уникальноеописаниесхемы'));
    expect(r.status).toBe(200);
    expect(r.body.fused.items).toEqual([]);
    expect(r.body.branchCounts).toEqual({ exact: 0, fts: 0, vector: 0 });
    expect(r.body.emptyMessage).toBe('не найдено в области: 2 единицы, 3 страницы распознано из 3');
    expect(JSON.stringify(r.body)).not.toMatch(/не предусмотрен/u);
  });
});

describe('пустая область', () => {
  it('этап без состава источников: прогон терминален сразу, без задания, итог сформулирован охватом', async () => {
    const empty = await s.manager.post(`/tenders/${s.tenderA}/stages`, { title: 'Этап без состава' }, { headers: idem() });
    const r = await post(searchBody(s.tenderA, empty.body.id, 'фасад'));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'complete', scope: { units: 0 }, fused: { items: [] } });
    expect(r.body.emptyMessage).toBe('не найдено в области: 0 единиц, 0 страниц распознано из 0');
    const jobs = await db.pool.query('SELECT 1 FROM job WHERE dedupe_key = $1', [`search:${r.body.searchRunId}`]);
    expect(jobs.rowCount).toBe(0);
  });
});

describe('два прогона одного PDF (RT-02, A10, A11)', () => {
  it('поздний прогон ранжируется выше; рабочий состав берёт его, снимок E1 — только ранний даже при limit = 1', async () => {
    ids.runKj2 = await seedEvidenceRun(db.pool, ids.revKj!, { pages: [{ blocks: ['Бетон класса B30 для фундаментов монолитной плиты'] }] });
    await buildIndex(db, worker);
    const v = (await getActiveVersion(db.pool))!;
    const lex = await queryLexemes(db.pool, 'класс бетона фундаментов монолитной плиты');
    // Если бы в области были оба прогона, поздний был бы первым: ранжирование его предпочитает.
    const both = await ftsBranch(db.pool, v.id, [ids.runKj1!, ids.runKj2!], lex, 5);
    expect(both[0]!.fragmentId).toBe(await fragmentIdOf(db.pool, ids.runKj2!, 'Бетон класса B30 для фундаментов монолитной плиты'));

    const working = await post(searchBody(s.tenderA, s.stageA, 'класс бетона фундаментов монолитной плиты', 1));
    expect(working.body.fused.items).toHaveLength(1);
    expect(working.body.fused.items[0].recognitionRunId).toBe(ids.runKj2);

    // Фильтр до ранжирования: top-1 по E1 — ранний прогон, а не пустота после отбрасывания позднего.
    const historical = await post(reviewBody(s.tenderA, ids.scopeE1!, 'класс бетона фундаментов монолитной плиты', 1));
    expect(historical.status, historical.text).toBe(200);
    expect(historical.body.context).toMatchObject({ mode: 'review', evidenceScopeId: ids.scopeE1 });
    expect(historical.body.fused.items).toHaveLength(1);
    expect(historical.body.fused.items[0]).toMatchObject({ recognitionRunId: ids.runKj1, text: 'Бетон класса B25 для фундаментов' });
    const units = await db.pool.query<{ allowed_source_unit_ids: string[] }>('SELECT allowed_source_unit_ids FROM search_run WHERE id = $1', [historical.body.searchRunId]);
    expect(units.rows[0]!.allowed_source_unit_ids).not.toContain(ids.runKj2);
  });
});

describe('снимок области доказательств (state-machines §5.1)', () => {
  it('без замороженной ревизии — 409; повтор того же состава — тот же снимок; чужой — 404', async () => {
    const none = await s.eng1.post(`/stages/${ids.stageA2}/evidence-scopes`, {}, { headers: idem() });
    expect(none.status).toBe(409);
    expect(none.body.current).toEqual({ reason: 'no_frozen_source_set' });
    const first = await s.eng1.get(`/evidence-scopes/${ids.scopeE1}`);
    expect(first.status).toBe(200);
    expect(first.body.items.map((i: { recognitionRunId: string }) => i.recognitionRunId).sort()).toEqual([ids.runKj1, ids.runTz].sort());
    const foreign = await s.eng3.get(`/evidence-scopes/${ids.scopeE1}`);
    expect(foreign.status).toBe(404);
    // После R2 состав этапа новый: новый снимок, E1 не меняется.
    const second = await s.eng1.post(`/stages/${s.stageA}/evidence-scopes`, {}, { headers: idem() });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(ids.scopeE1);
    const repeat = await s.eng1.post(`/stages/${s.stageA}/evidence-scopes`, {}, { headers: idem() });
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ id: second.body.id, reused: true });
    await expect(db.pool.query('UPDATE evidence_scope SET content_hash = content_hash WHERE id = $1', [ids.scopeE1])).rejects.toThrow(/permission denied|запрещена/u);
  });
});

describe('прогон поиска: чтение, права, неизменность', () => {
  it('прогон читает только автор; права поверх закреплённой области проверяются при чтении', async () => {
    const r = await post(searchBody(s.tenderA, s.stageA, 'кровля'));
    const other = await s.eng2.get(`/search-runs/${r.body.searchRunId}`);
    expect(other.status).toBe(404);
    const eng1 = (await loadAccessContext(db.pool, s.ids.eng1, 't'))!;
    const eng3 = (await loadAccessContext(db.pool, s.ids.eng3, 't'))!;
    expect(await unitsNotPermitted(db.pool, eng1, [ids.runTz!])).toEqual([]);
    expect(await unitsNotPermitted(db.pool, eng3, [ids.runTz!])).toEqual([ids.runTz]);
  });

  it('терминальный прогон неизменен: ни статус, ни результаты (frozen-after, immutable)', async () => {
    const r = await post(searchBody(s.tenderA, s.stageA, 'окна'));
    const runId = r.body.searchRunId as string;
    await expect(db.pool.query("UPDATE search_run SET status = 'complete' WHERE id = $1", [runId])).rejects.toThrow(/завершён/u);
    const f = r.body.fused.items[0].fragmentId as string;
    await expect(
      db.pool.query("INSERT INTO search_run_result (run_id, branch, rank, fragment_id, origin, score) VALUES ($1, 'fused', 99, $2, 'recognized_text', 1)", [runId, f]),
    ).rejects.toThrow(/нетерминальный/u);
    await expect(db.pool.query('DELETE FROM search_run_result WHERE run_id = $1', [runId])).rejects.toThrow(/permission denied|запрещена/u);
  });

  it('аудит: событие search.run с хэшем области, без текста запроса', async () => {
    const r = await post(searchBody(s.tenderA, s.stageA, 'утеплитель минераловатный'));
    const rows = await auditRows(db.pool, "action = 'search.run' AND entity_id = $1", [r.body.searchRunId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'allowed', tender_id: s.tenderA, details: { mode: 'working', scopeHash: r.body.scopeHash } });
    expect(JSON.stringify(rows[0]!.details)).not.toContain('минераловатный');
  });

  it('режимы release/comparison и вид contract — честный отказ до своих этапов', async () => {
    const release = await post({ context: { kind: 'tender', tenderId: s.tenderA, mode: 'release', releaseId: ids.revTz }, query: 'фасад' });
    expect(release.status).toBe(400);
    const contract = await post({ context: { kind: 'contract', contractId: ids.revTz }, query: 'фасад' });
    expect(contract.status).toBe(400);
  });
});

describe('переиндексация и удаление индекса', () => {
  it('новая версия не ломает старую цитату; удаление данных выведенной версии не трогает доказательства (I15)', async () => {
    const before = await post(searchBody(s.tenderA, s.stageA, 'чем облицовывается фасад'));
    const citation = before.body.fused.items[0].fragmentId as string;
    const oldVersion = (await getActiveVersion(db.pool))!.id;
    const fragmentsBefore = (await db.pool.query('SELECT count(*)::int AS n FROM evidence_fragment')).rows[0].n;

    await createVersion(db.pool, { chunkerVersion: CHUNKER_VERSION, embedding: null, createdBy: null });
    const newVersion = await buildIndex(db, worker);
    expect(newVersion).not.toBe(oldVersion);
    await worker.maintain();
    await drain(worker);
    const old = await db.pool.query('SELECT status, purged_at FROM search_index_version WHERE id = $1', [oldVersion]);
    expect(old.rows[0].status).toBe('retired');
    expect(old.rows[0].purged_at).not.toBeNull();
    const leftovers = await db.pool.query('SELECT count(*)::int AS n FROM search_chunk WHERE index_version_id = $1', [oldVersion]);
    expect(leftovers.rows[0].n).toBe(0);

    // Старый прогон читается как прежде, цитата открывается.
    const reread = await s.eng1.get(`/search-runs/${before.body.searchRunId}`);
    expect(fusedIds(reread.body)).toEqual(fusedIds(before.body));
    const evidence = await s.eng1.get(`/evidence/${citation}`);
    expect(evidence.status).toBe(200);
    expect(evidence.body.text).toBe(FACADE);
    // Новая версия цитирует тот же стабильный фрагмент.
    const after = await post(searchBody(s.tenderA, s.stageA, 'чем облицовывается фасад'));
    expect(after.body.index.versionId).toBe(newVersion);
    expect(after.body.fused.items[0].fragmentId).toBe(citation);
    const fragmentsAfter = (await db.pool.query('SELECT count(*)::int AS n FROM evidence_fragment')).rows[0].n;
    expect(fragmentsAfter).toBe(fragmentsBefore);
    const content = await s.eng1.get(`/document-revisions/${ids.revTz}/content`);
    expect(content.status).toBe(200);
  });
});

describe('сквозной путь: импорт экспорта RDWeb → индекс → поиск', () => {
  it('новый прогон дочитывается в активную версию; штамп находится точной веткой, описание модели — нет', async () => {
    const fx = buildRdwebExport({ docName: 'ТЗ-сквозной', pages: 2 });
    const up = await s.eng1.post(`/stages/${s.stageA}/imports?name=${encodeURIComponent('ТЗ-сквозной.pdf')}`, fx.pdf, {
      headers: { 'Content-Type': 'application/octet-stream', ...idem() },
    });
    await drain(worker);
    const revisionId = (await s.eng1.get(`/imports/${up.body.id}`)).body.items[0].documentRevisionId as string;
    const accepted = await s.eng1.post(`/document-revisions/${revisionId}/recognition-imports?name=export.zip`, fx.zip, {
      headers: { 'Content-Type': 'application/octet-stream', ...idem() },
    });
    expect(accepted.status, accepted.text).toBe(202);
    // Приём архива и индексация — одна очередь: index.build поставлен транзакцией завершения прогона.
    await drain(worker);
    const unit = await db.pool.query('SELECT 1 FROM search_index_unit u JOIN search_index_version v ON v.id = u.index_version_id WHERE v.status = $1 AND u.source_unit_id = $2', [
      'active',
      accepted.body.id,
    ]);
    expect(unit.rowCount).toBe(1);
    await setWorkingSet(s.eng1, s.stageA, [ids.revTz!, ids.revKj!, revisionId]);
    const stamp = await post(searchBody(s.tenderA, s.stageA, 'ФИКС-АР'));
    expect(stamp.body.fused.items[0]).toMatchObject({ recognitionRunId: accepted.body.id, fragmentKind: 'stamp_block' });
    expect(stamp.body.fused.items[0].matchedVia).toContain('exact');
    const text = await post(searchBody(s.tenderA, s.stageA, 'вторая строка распознанного текста'));
    expect(text.body.fused.items[0].recognitionRunId).toBe(accepted.body.id);
    // «насос, задвижка, фильтр» — только в Entities/Description модели: результатом не становится.
    const described = await post(searchBody(s.tenderA, s.stageA, 'насос задвижка фильтр'));
    expect(described.body.fused.items).toEqual([]);
  });
});
