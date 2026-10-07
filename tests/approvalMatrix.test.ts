// Этап 13 — уточнения матрицы D-033 (ответ владельца на В-13-1):
//  1) REVIEW_INCOMPLETE разделён по причинам: отсутствие прогона, необработанные страницы, ошибки обработки — риском не
//     снимаются; пробел оценки покрытия по обработанным данным (REVIEW_UNCERTAIN) — снимается;
//  2) устаревшее основание поля (FIELDS_STALE) риском не снимается — нужно актуальное значение и пересборка;
//  3) риск, принятый в этапе 09, действует, пока действуют замечание и его основания; изменение оснований требует нового
//     решения, прежний риск остаётся в истории;
//  4) «не влияет» снимает удержание только по своим событиям и не отменяет актуальности оснований.
// S13-04: несколько «не сверено» по одному полю (сверка с другими приложениями этапа) — один пункт на версию поля.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { draftOf, setValue } from './formsFixtures.ts';
import { idem } from './helpers.ts';
import { completeDraft } from './releaseFixtures.ts';
import { acceptAll, acceptRisk, approve, assembled, buildStage13, closeStage13, codes, filledDraft, notApplicable, TZ, view, type IStage13 } from './approvalFixtures.ts';
import { etagOf } from './reviewFixtures.ts';
import { fragmentIdOf, seedEvidenceRun, uploadDocument } from './searchFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const pgCode = async (st: IStage13, sql: string, params: unknown[]): Promise<string> =>
  st.db.pool.query(sql, params).then(
    () => 'ok',
    (x: { code?: string }) => x.code ?? 'error',
  );

describe('D-033 ут. 1 — неполная обработка и ошибки обработки риском не снимаются', () => {
  let st: IStage13;
  beforeAll(async () => {
    st = await buildStage13({ missingPage: true, modelError: true });
  });
  afterAll(async () => {
    await closeStage13(st);
  });

  it('непрочитанная страница и отказ модели — REVIEW_PROCESSING_INCOMPLETE; пробел покрытия — снимаемый REVIEW_UNCERTAIN; БД отвергает согласование', async () => {
    expect(st.run.checks.find((c) => c.code === 'processing')!.outcome).toBe('incomplete');
    expect(st.run.checks.find((c) => c.code === 'model_hypotheses')!.outcome).toBe('error');
    let c = await assembled(st);
    const processing = c.gate.approve!.blockers.find((b) => b.code === 'REVIEW_PROCESSING_INCOMPLETE')!;
    expect(processing).toMatchObject({ class: 'integrity', acceptable: false });
    const titles = processing.items.map((i) => i.title);
    expect(titles.some((t) => /^Полнота обработки источников: неполно/u.test(t))).toBe(true);
    expect(titles.some((t) => /^Гипотезы модели: ошибка/u.test(t))).toBe(true);
    expect(c.gate.approve!.blockers.find((b) => b.code === 'REVIEW_UNCERTAIN')).toMatchObject({ class: 'business', acceptable: true });
    await acceptAll(st, c);
    c = await view(st, c.id);
    expect(codes(c.gate.approve)).toEqual(['REVIEW_PROCESSING_INCOMPLETE']);
    const risk = await acceptRisk(st, c, { blockerCode: 'REVIEW_PROCESSING_INCOMPLETE', subjectType: 'review_check_result', subjectId: processing.items[0]!.subjectId, reason: 'Страница не важна' });
    expect(risk.body.current.reason).toBe('risk_not_acceptable');
    const r = await approve(st, c);
    expect(r.status).toBe(409);
    expect(codes(r.body as never)).toEqual(['REVIEW_PROCESSING_INCOMPLETE']);
    expect(await pgCode(st, 'INSERT INTO approval (candidate_id, tender_id, stage_id, candidate_content_hash, input_version, gate, approved_by) VALUES ($1, $2, $3, $4, 0, \'{}\', $5)', [
      c.id, st.e.s.tenderA, st.e.s.stageA, c.contentHash, st.e.s.ids.manager,
    ])).toBe('23514');
    // Принятие риска по проверке обработки в обход API — CHECK кода и охранник предмета.
    expect(await pgCode(st, `INSERT INTO risk_acceptance (candidate_id, tender_id, stage_id, blocker_code, subject_type, subject_id, reason, accepted_by)
       VALUES ($1, $2, $3, 'REVIEW_UNCERTAIN', 'review_check_result', $4, 'обход неполной обработки', $5)`, [c.id, st.e.s.tenderA, st.e.s.stageA, processing.items[0]!.subjectId, st.e.s.ids.manager])).toBe('23514');
  });
});

describe('D-033 ут. 1 — без обязательного прогона проверок', () => {
  let st: IStage13;
  beforeAll(async () => {
    st = await buildStage13({ review: false });
  });
  afterAll(async () => {
    await closeStage13(st);
  });

  it('комплект без прогона проверок собирается, но не согласуется: REVIEW_MISSING риском не снимается', async () => {
    let c = await assembled(st);
    await acceptAll(st, c);
    c = await view(st, c.id);
    expect(codes(c.gate.approve)).toEqual(['REVIEW_MISSING']);
    expect((await acceptRisk(st, c, { blockerCode: 'REVIEW_MISSING', subjectType: 'candidate', subjectId: c.id, reason: 'Проверим позже' })).body.current.reason).toBe('risk_not_acceptable');
    expect(codes((await approve(st, c)).body as never)).toEqual(['REVIEW_MISSING']);
  });
});

describe('D-033 ут. 2–4 — устаревшее основание поля и риск этапа 09 после смены оснований', () => {
  let st: IStage13;
  let findingId = '';
  beforeAll(async () => {
    st = await buildStage13();
  });
  afterAll(async () => {
    await closeStage13(st);
  });

  it('риск этапа 09 по критическому замечанию снимает пункт, пока замечание и основания действуют', async () => {
    const run = (await st.db.pool.query("SELECT r.id FROM recognition_run r WHERE r.document_revision_id = $1 ORDER BY r.created_at LIMIT 1", [st.tzRev])).rows[0].id;
    const paint = await fragmentIdOf(st.db.pool, run, TZ.paint);
    const plaster = await fragmentIdOf(st.db.pool, run, TZ.plaster);
    // Поле письма с основанием — фрагмент ТЗ (D-031: значение с источником).
    await setValue(st.e.s.eng1, st.drafts.letter, 'conditions_text', 'Окраска фасада выполняется в два слоя', [{ type: 'fragment', id: paint }]);
    if ((await draftOf(st.e.s.eng1, st.drafts.letter)).status !== 'complete') await completeDraft(st.e.s.eng1, st.drafts.letter);
    // Критическое замечание человека по фрагменту ТЗ; руководитель принимает риск в этапе 09 (D-029 В-09-3).
    const f = await st.e.s.eng1.post(
      `/stages/${st.e.s.stageA}/findings`,
      { title: 'Объём штукатурки требует проверки', severity: 'critical', confidence: 'medium', evidence: [{ side: 'left', fragmentId: plaster }] },
      { headers: idem() },
    );
    expect(f.status, f.text).toBe(201);
    findingId = f.body.id as string;
    const tr = await st.e.s.manager.post(
      `/findings/${findingId}/transitions`,
      { to: 'accepted_risk', reason: 'Объём сверен с заказчиком устно', statement: 'Риск по объёму штукатурки принят' },
      { headers: { 'If-Match': await etagOf(st.e.s.manager, `/findings/${findingId}`), ...idem() } },
    );
    expect(tr.status, tr.text).toBe(200);
    const c = await assembled(st);
    expect(codes(c.gate.approve)).not.toContain('CRITICAL_FINDINGS_OPEN');
    expect(c.gate.warnings!.reviewRisks.map((r) => r.findingId)).toContain(findingId);
    expect(codes(c.gate.approve)).not.toContain('FIELDS_STALE');
  });

  it('новая редакция ТЗ: «не влияет» снимает только удержания; устаревшее основание поля (FIELDS_STALE) не снимается ни решением, ни риском; риск этапа 09 перестаёт действовать', async () => {
    let c = await assembled(st);
    // Новая редакция того же документа после сборки: события, удержания; инвалидация — в команде согласования.
    const v2 = await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'ТЗ.pdf');
    expect(v2).not.toBe(st.tzRev);
    await seedEvidenceRun(st.db.pool, v2, { pages: [{ blocks: [TZ.plaster, TZ.paint] }] });
    await acceptAll(st, c);
    const first = await approve(st, (c = await view(st, c.id)));
    expect(codes(first.body as never)).toContain('INPUTS_CHANGED');
    await notApplicable(st, c.id, 'Новая редакция ТЗ, по мнению руководителя, не меняет КП');
    c = await view(st, c.id);
    const open = codes(c.gate.approve);
    expect(open).not.toContain('INPUTS_CHANGED');
    expect(open).toContain('FIELDS_STALE');
    expect(open).toContain('CRITICAL_FINDINGS_OPEN');
    const stale = c.gate.approve!.blockers.find((b) => b.code === 'FIELDS_STALE')!;
    expect(stale).toMatchObject({ class: 'integrity', acceptable: false });
    expect((await acceptRisk(st, c, { blockerCode: 'FIELDS_STALE', subjectType: 'field_version', subjectId: stale.items[0]!.subjectId, reason: 'Значение верно и так' })).body.current.reason).toBe('risk_not_acceptable');
    // Пункт «не сверено» по полю с устаревшим основанием — тоже не принимается (D-033 ут. 2: «если остальные проверки пройдены»).
    const fieldItem = c.gate.approve!.blockers.find((b) => b.code === 'FIELDS_INCOMPLETE')?.items.find((i) => i.subjectId === stale.items[0]!.subjectId);
    if (fieldItem) expect(fieldItem.acceptable).toBe(false);
    const r = await approve(st, c);
    expect(r.status).toBe(409);
    expect(codes(r.body as never)).toEqual(expect.arrayContaining(['FIELDS_STALE', 'CRITICAL_FINDINGS_OPEN']));
    expect(codes(r.body as never)).not.toContain('INPUTS_CHANGED');
    // Замечание стало «устарело»; прежнее принятие риска этапа 09 — в истории замечания (D-033 ут. 3).
    const events = (await st.db.pool.query("SELECT to_value FROM finding_event WHERE finding_id = $1 AND event_kind = 'status' ORDER BY seq", [findingId])).rows.map((x) => x.to_value);
    expect(events).toEqual(expect.arrayContaining(['accepted_risk', 'stale']));
    expect((await st.e.s.eng1.get(`/findings/${findingId}`)).body.status).toBe('stale');
  });
});

describe('S13-04 — несколько «не сверено» по одному полю — один пункт матрицы', () => {
  let st: IStage13;
  beforeAll(async () => {
    st = await buildStage13();
  });
  afterAll(async () => {
    await closeStage13(st);
  });

  it('второе письмо этапа добавляет сверки к полю условий: пункт поля один, риск по нему принимается один раз, комплект согласуется', async () => {
    await filledDraft(st, 'letter', 'Второе письмо КП');
    let c = await assembled(st);
    await notApplicable(st, c.id, 'Второе письмо в комплект не входит');
    c = await view(st, c.id);
    const items = c.gate.approve!.blockers.find((b) => b.code === 'FIELDS_INCOMPLETE')!.items;
    expect(new Set(items.map((i) => i.subjectId)).size).toBe(items.length);
    expect(items.some((i) => i.title.includes('«Второе письмо КП»') && i.title.includes('; '))).toBe(true);
    await acceptAll(st, c);
    c = await view(st, c.id);
    expect(codes(c.gate.approve)).toEqual([]);
    const a = await approve(st, c);
    expect(a.status, a.text).toBe(200);
  });
});
