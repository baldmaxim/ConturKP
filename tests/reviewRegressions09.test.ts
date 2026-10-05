// Этап 09, Review 09-1: регрессии R09-01 (событие, обработанное до результатов прогона), R09-02 (содержимое входов
// закрепляется при запуске) и R09-03 (решение и ось по устаревшему замечанию). Порядок независимых заданий задаётся
// сроком задания в очереди — допустимый порядок исполнения, таблицы продукта тест не меняет.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, drain, idem, testConfig, type ITestDb } from './helpers.ts';
import { buildStage09, checkOf, closeHub, cover, findings, line, requirement, RT, startRun, type IRunView, type IStage09 } from './reviewFixtures.ts';
import { seedEvidenceRun, uploadDocument } from './searchFixtures.ts';

const holdReviewJobs = (db: ITestDb) => db.pool.query("UPDATE job SET run_after = now() + interval '1 hour' WHERE kind LIKE 'review.%' AND status = 'queued'");
const releaseReviewJobs = (db: ITestDb) => db.pool.query("UPDATE job SET run_after = now() WHERE kind LIKE 'review.%' AND status = 'queued'");
const transition = async (client: IStage09['s']['eng1'], id: string, body: object) =>
  client.post(`/findings/${id}/transitions`, body, { headers: { 'If-Match': (await client.get(`/findings/${id}`)).headers.etag as string, ...idem() } });
const masonryFinding = async (st: IStage09, code: string) => (await findings(st)).filter((f) => f.kind === 'quantity_mismatch' && f.requirements.includes(code));
const RISK = { to: 'accepted_risk', reason: 'Объём уточнится при выходе РД', statement: 'Принять риск расхождения объёма кладки' };

describe('R09-01: событие, обработанное до записи результатов', () => {
  let db: ITestDb;
  let st: IStage09;
  let code: string;
  let run: IRunView;

  beforeAll(async () => {
    db = await createTestDb();
    st = await buildStage09(db, testConfig());
    const r = await requirement(st, 'Кладка стен — 55 м3', [{ name: 'Объём кладки', value: '55', unit: 'м3' }], [st.frag.masonry]);
    code = r.code;
    await cover(st, r.revisionId, { state: 'covered', objects: [line(st, RT.masonry, RT.masonryLine)] });
    // Требование без похожей позиции: поддельная модель предложит гипотезу с цитатой прежней редакции ТЗ.
    await requirement(st, 'Молниезащита кровли по ТЗ', [], [st.frag.pd]);
    // Проверка — в очереди на прежнем снимке; новая редакция ТЗ регистрируется и её событие обрабатывается раньше проверки.
    const queued = await startRun(st);
    await holdReviewJobs(db);
    await uploadDocument(db, st.config, st.s.eng1, st.s.stageA, 'ТЗ.pdf');
    await st.worker.scheduleStageInvalidation();
    await drain(st.worker);
    const processed = await db.pool.query("SELECT 1 FROM stage_input_event_processing p JOIN stage_input_event e ON e.id = p.event_id WHERE e.event_type = 'document_revision_registered' AND e.seq > (SELECT stage_input_version FROM review_run WHERE id = $1)", [queued.id]);
    expect(processed.rowCount).toBe(1);
    expect((await db.pool.query('SELECT status FROM review_run WHERE id = $1', [queued.id])).rows[0].status).toBe('queued');
    await releaseReviewJobs(db);
    await drain(st.worker);
    run = (await st.s.eng1.get(`/review-runs/${queued.id}`)).body as IRunView;
  });
  afterAll(async () => {
    await closeHub(st);
    await db.drop();
  });

  it('поздно записанное замечание сразу «устарело» с причиной события; прогон «устарел»', async () => {
    expect(run.status).toBe('completed_with_gaps');
    expect(run.freshness.outdated).toBe(true);
    const [f] = await masonryFinding(st, code);
    expect(f, JSON.stringify((await findings(st)).map((x) => [x.kind, x.status]))).toBeTruthy();
    expect(f!.status).toBe('stale');
    const d = (await st.s.eng1.get(`/findings/${f!.id}`)).body;
    expect(d.invalidations[0]).toMatchObject({ mode: 'exact', eventType: 'document_revision_registered' });
    expect(d.events.at(-1)).toMatchObject({ kind: 'status', to: 'stale', actor: 'система' });
  });

  it('гипотеза модели с цитатой прежней редакции, записанная после события, — «истекла»; принять нельзя', async () => {
    expect(run.suggestions.length).toBeGreaterThan(0);
    expect(run.suggestions.every((x) => x.status === 'expired')).toBe(true);
    const r = await st.s.eng1.post(`/model-suggestions/${run.suggestions[0]!.id}/accept`, { severity: 'minor', reason: null }, { headers: idem() });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('suggestion_not_open');
  });

  it('принятие риска по устаревшему замечанию — 409, решение не записано', async () => {
    const [f] = await masonryFinding(st, code);
    const r = await transition(st.s.manager, f!.id, RISK);
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('finding_stale');
    expect((await db.pool.query("SELECT count(*)::int AS n FROM decision WHERE decision_type = 'finding_risk_acceptance'")).rows[0].n).toBe(0);
  });
});

describe('R09-01: событие ещё не обработано, когда приходит решение', () => {
  let db: ITestDb;
  let st: IStage09;
  let code: string;

  beforeAll(async () => {
    db = await createTestDb();
    st = await buildStage09(db, testConfig());
    const r = await requirement(st, 'Кладка стен — 55 м3', [{ name: 'Объём кладки', value: '55', unit: 'м3' }], [st.frag.masonry]);
    code = r.code;
    await cover(st, r.revisionId, { state: 'covered', objects: [line(st, RT.masonry, RT.masonryLine)] });
    await startRun(st);
    await drain(st.worker);
    // Новая редакция ТЗ: событие есть, задание инвалидации ещё не выполнялось.
    await uploadDocument(db, st.config, st.s.eng1, st.s.stageA, 'ТЗ.pdf');
  });
  afterAll(async () => {
    await closeHub(st);
    await db.drop();
  });

  it('команда под блокировкой этапа обрабатывает событие сама: риск — 409, замечание «устарело»', async () => {
    const [f] = await masonryFinding(st, code);
    expect(f!.status).toBe('open');
    const pending = await db.pool.query('SELECT count(*)::int AS n FROM stage_input_event e WHERE NOT EXISTS (SELECT 1 FROM stage_input_event_processing p WHERE p.event_id = e.id)');
    expect(pending.rows[0].n).toBeGreaterThan(0);
    const r = await transition(st.s.manager, f!.id, RISK);
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('finding_stale');
    const [after] = await masonryFinding(st, code);
    expect(after!.status).toBe('stale');
    expect((await db.pool.query("SELECT count(*)::int AS n FROM decision WHERE decision_type = 'finding_risk_acceptance'")).rows[0].n).toBe(0);
  });

  it('вторая линия: решение и ось при необработанном событии этапа или по устаревшему замечанию — отказ БД', async () => {
    const [f] = await masonryFinding(st, code);
    const code23514 = async (fn: (c: pg.PoolClient) => Promise<unknown>) => {
      const c = await db.pool.connect();
      try {
        await c.query('BEGIN');
        await fn(c);
        await c.query('COMMIT');
        return 'ok';
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        return (e as { code?: string }).code;
      } finally {
        c.release();
      }
    };
    expect(
      await code23514((c) =>
        c.query(
          `INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by)
           VALUES ($1, $2, 'finding', $3, 'finding_risk_acceptance', 'риск', 'причина', $4)`,
          [st.s.tenderA, st.s.stageA, f!.id, st.s.ids.manager],
        ),
      ),
    ).toBe('23514');
    // Необработанное событие этапа: новая редакция договора — решение по другому (открытому) замечанию отвергается БД.
    const open = (await findings(st)).find((x) => x.status === 'open' && x.riskAcceptable);
    if (open) {
      await uploadDocument(db, st.config, st.s.eng1, st.s.stageA, 'Проект договора.pdf');
      expect(
        await code23514((c) =>
          c.query(
            `INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by)
             VALUES ($1, $2, 'finding', $3, 'finding_resolution', 'решено', 'причина', $4)`,
            [st.s.tenderA, st.s.stageA, open.id, st.s.ids.eng1],
          ),
        ),
      ).toBe('23514');
    }
  });
});

describe('R09-02: входы прогона закрепляются при запуске', () => {
  let db: ITestDb;
  let st: IStage09;

  beforeAll(async () => {
    db = await createTestDb();
    st = await buildStage09(db, testConfig());
  });
  afterAll(async () => {
    await closeHub(st);
    await db.drop();
  });

  it('требование, подтверждённое после запуска, в прежний прогон не входит; прогон «устарел» с причиной', async () => {
    const queued = await startRun(st);
    const lamp = await requirement(st, 'Светильники в коридорах — тип №1', [{ name: 'Тип светильника', value: '№1' }], [st.frag.lamp]);
    await cover(st, lamp.revisionId, { state: 'covered', objects: [line(st, RT.lamp, RT.lampLine)] });
    await drain(st.worker);
    const v = (await st.s.eng1.get(`/review-runs/${queued.id}`)).body as IRunView;
    expect(v.status).toBe('completed_with_gaps');
    expect(checkOf(v, 'coverage')).toMatchObject({ outcome: 'not_applicable', counts: expect.objectContaining({ requirements: 0 }) });
    expect(checkOf(v, 'parameters').outcome).toBe('not_applicable');
    expect(checkOf(v, 'model_hypotheses').counts.requirements ?? 0).toBe(0);
    expect((await findings(st)).some((f) => f.kind === 'parameter_mismatch')).toBe(false);
    expect(v.freshness.outdated).toBe(true);
    expect(v.freshness.reasons.join(' ')).toMatch(/реестр требований, покрытие или записи этапа/u);
    expect(v.inputs.inputSha256).toMatch(/^[0-9a-f]{64}$/u);
    // Новый запуск — собственный ID и снимок с требованием.
    const next = await startRun(st);
    expect(next.id).not.toBe(queued.id);
    await drain(st.worker);
    const n = (await st.s.eng1.get(`/review-runs/${next.id}`)).body as IRunView;
    expect(checkOf(n, 'coverage').counts.requirements).toBe(1);
    expect((await findings(st)).some((f) => f.kind === 'parameter_mismatch' && f.requirements.includes(lamp.code))).toBe(true);
    expect(n.freshness.outdated).toBe(false);
  });

  it('вход закреплён в БД: неизменяемый, пишется только в транзакции запуска', async () => {
    const id = (await db.pool.query('SELECT run_id FROM review_run_input LIMIT 1')).rows[0].run_id;
    const code = async (sql: string, params: unknown[]) => db.pool.query(sql, params).then(() => 'ok', (e: { code?: string }) => e.code);
    expect(await code("UPDATE review_run_input SET input = '{}' WHERE run_id = $1", [id])).toBe('42501');
    expect(await code("INSERT INTO review_run_input (run_id, input, input_sha256, content_fingerprint) VALUES ($1, '{}', repeat('a', 64), repeat('b', 64))", [id])).not.toBe('ok');
  });
});

describe('R09-03: решение, ось и граф по устаревшему замечанию', () => {
  let db: ITestDb;
  let st: IStage09;
  let masonryCode: string;

  beforeAll(async () => {
    db = await createTestDb();
    st = await buildStage09(db, testConfig(), {
      extraDocs: [
        { name: 'Договор поставки.pdf', blocks: ['Договор поставки № П-9 от 01.02.2026', '3.1. Аванс составляет 25% от цены договора.'] },
        { name: 'ДС-1 без даты.pdf', blocks: ['Дополнительное соглашение № 1 к договору поставки № П-9 от 01.02.2026', 'Пункт 3.1 договора изложить в новой редакции: «Аванс составляет 15% от цены договора».'] },
      ],
    });
    const r = await requirement(st, 'Кладка стен — 55 м3', [{ name: 'Объём кладки', value: '55', unit: 'м3' }], [st.frag.masonry]);
    masonryCode = r.code;
    await cover(st, r.revisionId, { state: 'covered', objects: [line(st, RT.masonry, RT.masonryLine)] });
    await startRun(st);
    await drain(st.worker);
  });
  afterAll(async () => {
    await closeHub(st);
    await db.drop();
  });

  it('разногласие у «устаревшего» замечания: решение и ось — 409, ничего не записано; новое разногласие — тоже 409', async () => {
    const [f] = await masonryFinding(st, masonryCode);
    const disc = await st.s.eng1.post(`/findings/${f!.id}/discrepancy`, { topic: 'Объём кладки' }, { headers: idem() });
    expect(disc.status, disc.text).toBe(201);
    const dId = disc.body.discrepancy.id as string;
    const dup = (await findings(st)).find((x) => x.kind === 'duplicate_position')!;
    await uploadDocument(db, st.config, st.s.eng1, st.s.stageA, 'ТЗ.pdf');
    await st.worker.scheduleStageInvalidation();
    await drain(st.worker);
    expect((await st.s.eng1.get(`/findings/${f!.id}`)).body.status).toBe('stale');
    const decision = await st.s.manager.post(`/discrepancies/${dId}/decisions`, { statement: 'Принять 50 м3', rationale: 'по смете' }, { headers: idem() });
    expect(decision.status, decision.text).toBe(409);
    expect(decision.body.current.reason).toBe('finding_stale');
    const axis = await st.s.eng1.post(`/discrepancies/${dId}/status-events`, { axis: 'calculation', value: 'reflected', reason: 'учтено', bases: [] }, { headers: idem() });
    expect(axis.status, axis.text).toBe(409);
    expect(axis.body.current.reason).toBe('finding_stale');
    const counts = await db.pool.query("SELECT (SELECT count(*)::int FROM decision WHERE decision_type = 'discrepancy_decision') AS d, (SELECT count(*)::int FROM discrepancy_status_event) AS e");
    expect(counts.rows[0]).toEqual({ d: 0, e: 0 });
    // Замечание другого семейства (дубль позиции) от новой редакции ТЗ не зависит и остаётся действующим.
    expect((await st.s.eng1.get(`/findings/${dup.id}`)).body.status).toBe('open');
  });

  it('ветка графа D-018: конфликт фактов устарел (новая редакция допсоглашения) — решение по графу не записывается', async () => {
    const conflict = (await findings(st)).find((x) => x.kind === 'source_conflict' && x.title.startsWith('Размер аванса'))!;
    expect(conflict, JSON.stringify((await findings(st)).map((x) => x.title))).toBeTruthy();
    const disc = await st.s.eng1.post(`/findings/${conflict.id}/discrepancy`, { topic: 'Аванс' }, { headers: idem() });
    expect(disc.status, disc.text).toBe(201);
    const left = disc.body.graphFacts.left[0] as string;
    const rev = await uploadDocument(db, st.config, st.s.eng1, st.s.stageA, 'ДС-1 без даты.pdf');
    await seedEvidenceRun(db.pool, rev, { pages: [{ blocks: ['Дополнительное соглашение № 1 от 10.03.2026 к договору поставки № П-9 от 01.02.2026', 'Пункт 3.1 договора изложить в новой редакции: «Аванс составляет 15% от цены договора».'] }] });
    const r = await st.s.manager.post(`/discrepancies/${disc.body.discrepancy.id}/decisions`, { statement: 'Действует 25%', rationale: 'договор', graph: { kind: 'prevails', prevailingFactId: left } }, { headers: idem() });
    expect(r.status, r.text).toBe(409);
    expect(r.body.current.reason).toBe('finding_stale');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM fact_decision')).rows[0].n).toBe(0);
    expect((await st.s.eng1.get(`/findings/${conflict.id}`)).body.status).toBe('stale');
  });
});
