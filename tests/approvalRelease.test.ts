// Этап 13 — согласование и выпуск через API на настоящем worker и LibreOffice (D-033; проверки задания, A08, A09, A25,
// A26, A45, RT-05, RT-07): инженер не согласует, модель не выпускает; матрица блокеров с принятием бизнес-риска, технические
// блокеры риском не снимаются; согласование показанного содержимого; повторы; источник между проверкой готовности и
// выпуском; удержание отправки после выпуска; отзыв и возврат; старое согласование не выдаётся за новое; изменение файла
// после согласования; принятый риск не скрывает вопрос; боевой режим с ограничениями Q-01/X-01, Q-08, Q-05.
import { createHash } from 'node:crypto';
import PizZip from 'pizzip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, draftOf, fieldOf } from './formsFixtures.ts';
import { auditRows, drain, idem, TestClient } from './helpers.ts';
import { completeDraft } from './releaseFixtures.ts';
import {
  acceptAll,
  acceptRisk,
  approve,
  assembled,
  buildStage13,
  closeStage13,
  codes,
  notApplicable,
  openHolds,
  release,
  rerunReview,
  tamperBlob,
  view,
  type ICandidate13,
  type IStage13,
} from './approvalFixtures.ts';
import { uploadDocument } from './searchFixtures.ts';

// Сборки LibreOffice на Windows под нагрузкой дольше 30 с (Review 12-1): предел — с запасом.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let st: IStage13;
let c1: ICandidate13;
let approval1 = '';
let release1 = '';
let modelUser = '';

const pgCode = async (sql: string, params: unknown[]): Promise<string> =>
  st.db.pool.query(sql, params).then(
    () => 'ok',
    (x: { code?: string }) => x.code ?? 'error',
  );

const questionStatus = async (id: string): Promise<string> =>
  ((await st.e.s.eng1.get(`/stages/${st.e.s.stageA}/customer-questions`)).body.items as { id: string; status: string }[]).find((x) => x.id === id)!.status;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  st = await buildStage13();
  expect(st.run.status, JSON.stringify(st.run.checks.map((c) => [c.code, c.outcome, c.reason]))).toBe('completed_with_gaps');
  modelUser = (await st.db.pool.query("INSERT INTO app_user (kind, service_kind, login, display_name) VALUES ('service', 'model', 'model.release', 'Модель') RETURNING id")).rows[0].id;
  c1 = await assembled(st);
});
afterAll(async () => {
  await closeStage13(st);
});

describe('права: инженер не согласует, модель не выпускает (A25, I12, ADR-006 §3)', () => {
  it('инженер напрямую вызывает approve — 403 и «запрещено» в журнале; кандидат не меняется; вставка БД — 42501', async () => {
    const r = await approve(st, c1, { client: st.e.s.eng1 });
    expect(r.status, r.text).toBe(403);
    const denied = await auditRows(st.db.pool, "action = 'release.candidate.approve' AND outcome = 'denied' AND actor_user_id = $1", [st.e.s.ids.eng1]);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.details).toMatchObject({ code: 'FORBIDDEN', capability: 'candidate.approve' });
    expect((await view(st, c1.id)).status).toBe('ready_for_approval');
    expect(await pgCode('INSERT INTO approval (candidate_id, tender_id, stage_id, candidate_content_hash, input_version, gate, approved_by) VALUES ($1, $2, $3, $4, 0, \'{}\', $5)', [
      c1.id, st.e.s.tenderA, st.e.s.stageA, c1.contentHash, st.e.s.ids.eng1,
    ])).toBe('42501');
    // Участник другого тендера — 404, без раскрытия существования (ADR-006 §7).
    expect((await approve(st, c1, { client: st.e.s.eng3 })).status).toBe(404);
  });

  it('модель вызывает release: у сервисной учётной записи нет входа и возможностей; вставки выпуска, согласования, риска и решений отвергаются БД; Bearer без сессии — 401', async () => {
    expect((await st.db.pool.query('SELECT tender_capabilities($1, $2) AS caps', [modelUser, st.e.s.tenderA])).rows[0].caps).toEqual([]);
    expect((await new TestClient(st.e.app).login('model.release', 'любой')).status).toBe(401);
    const bearer = new TestClient(st.e.app);
    const headers = { Authorization: 'Bearer model-token', 'If-Match': c1.etag, ...idem() };
    expect((await bearer.post(`/release-candidates/${c1.id}/release`, { approvalId: c1.id, contentHash: c1.contentHash }, { headers })).status).toBe(401);
    expect((await bearer.post(`/release-candidates/${c1.id}/approve`, { contentHash: c1.contentHash }, { headers })).status).toBe(401);
    expect(await pgCode('INSERT INTO approval (candidate_id, tender_id, stage_id, candidate_content_hash, input_version, gate, approved_by) VALUES ($1, $2, $3, $4, 0, \'{}\', $5)', [
      c1.id, st.e.s.tenderA, st.e.s.stageA, c1.contentHash, modelUser,
    ])).toBe('42501');
    expect(await pgCode(
      `INSERT INTO risk_acceptance (candidate_id, tender_id, stage_id, blocker_code, subject_type, subject_id, reason, accepted_by)
       SELECT $1, $2, $3, 'NUMBERS_UNVERIFIED', 'candidate_check', $1, 'причина модели для проверки', $4`,
      [c1.id, st.e.s.tenderA, st.e.s.stageA, modelUser],
    )).toBe('42501');
    const event = (await st.db.pool.query('SELECT id FROM stage_input_event WHERE stage_id = $1 ORDER BY seq LIMIT 1', [st.e.s.stageA])).rows[0].id;
    expect(await pgCode(
      `INSERT INTO decision (tender_id, stage_id, subject_type, subject_id, decision_type, statement, rationale, decided_by)
       VALUES ($1, $2, 'stage_input_event', $3, 'input_event_disposition', 'не влияет', 'решение модели', $4)`,
      [st.e.s.tenderA, st.e.s.stageA, event, modelUser],
    )).toBe('42501');
  });
});

describe('матрица блокеров и принятие риска (D-033, A45)', () => {
  it('согласование при непринятых бизнес-блокерах — 409 BLOCKER_PRESENT со списком; отказ в журнале «запрещено» с кодами', async () => {
    expect(codes(c1.gate.approve)).toEqual(['REVIEW_UNCERTAIN', 'FIELDS_INCOMPLETE']);
    const r = await approve(st, c1);
    expect(r.status, r.text).toBe(409);
    expect(r.body.code).toBe('BLOCKER_PRESENT');
    expect((r.body.blockers as { code: string; class: string }[]).map((b) => [b.code, b.class])).toEqual([
      ['REVIEW_UNCERTAIN', 'business'],
      ['FIELDS_INCOMPLETE', 'business'],
    ]);
    const denied = await auditRows(st.db.pool, "action = 'release.candidate.approve' AND outcome = 'denied' AND actor_user_id = $1", [st.e.s.ids.manager]);
    expect(denied.at(-1)!.details).toMatchObject({ code: 'BLOCKER_PRESENT', blockers: ['REVIEW_UNCERTAIN', 'FIELDS_INCOMPLETE'] });
  });

  it('технические нарушения, права и целостность риском не снимаются: 409 risk_not_acceptable; инженер — 403; БД — CHECK', async () => {
    for (const code of ['CANDIDATE_CONTENT_MISMATCH', 'INPUTS_CHANGED', 'REVIEW_PROCESSING_INCOMPLETE', 'FIELDS_STALE', 'TEMPLATE_DEMO', 'ACTOR_NOT_AUTHORIZED']) {
      const r = await acceptRisk(st, c1, { blockerCode: code, subjectType: 'candidate', subjectId: c1.id, reason: 'Попытка принять технический риск' });
      expect(r.status, r.text).toBe(409);
      expect(r.body.current.reason).toBe('risk_not_acceptable');
    }
    const item = c1.gate.approve!.blockers[0]!.items[0]!;
    expect((await acceptRisk(st, c1, { blockerCode: 'REVIEW_UNCERTAIN', subjectType: item.subjectType, subjectId: item.subjectId, reason: 'Инженер пытается принять риск' }, st.e.s.eng1)).status).toBe(403);
    expect(await pgCode(
      `INSERT INTO risk_acceptance (candidate_id, tender_id, stage_id, blocker_code, subject_type, subject_id, reason, accepted_by)
       VALUES ($1, $2, $3, 'TEMPLATE_DEMO', 'candidate_check', $1, 'обход технического блокера', $4)`,
      [c1.id, st.e.s.tenderA, st.e.s.stageA, st.e.s.ids.manager],
    )).toBe('23514');
  });

  it('руководитель принимает риск по каждому пункту с причиной; повтор по тому же пункту — already_accepted; пункт не из матрицы — not_a_blocker', async () => {
    expect(await acceptAll(st, c1)).toBe(3);
    c1 = await view(st, c1.id);
    expect(c1.gate.approve!.ok).toBe(true);
    const item = c1.gate.approve!.blockers[0]!.items[0]!;
    expect(item.acceptance?.reason).toMatch(/Риск принят руководителем/u);
    const again = await acceptRisk(st, c1, { blockerCode: 'REVIEW_UNCERTAIN', subjectType: item.subjectType, subjectId: item.subjectId, reason: 'Повторное принятие риска' });
    expect(again.status).toBe(409);
    expect(again.body.current.reason).toBe('already_accepted');
    const other = await acceptRisk(st, c1, { blockerCode: 'QUESTIONS_UNANSWERED', subjectType: 'customer_question', subjectId: c1.id, reason: 'Вопроса с таким идентификатором нет' });
    expect(other.body.current.reason).toBe('not_a_blocker');
  });

  it('согласуется только показанное содержимое; тот же ключ — тот же ответ; новый ключ — already_approved; согласование хранит оценку матрицы и принятые риски', async () => {
    const wrong = await approve(st, c1, { contentHash: '0'.repeat(64) });
    expect(wrong.status).toBe(409);
    expect(wrong.body.current.reason).toBe('content_changed');
    const key = idem();
    const r = await approve(st, c1, { key, comment: 'Согласовано с телефона' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'approved', approval: { status: 'active', contentHash: c1.contentHash, acceptedRiskIds: expect.any(Array) } });
    expect(r.body.approval.acceptedRiskIds).toHaveLength(3);
    approval1 = r.body.approval.id as string;
    const replay = await approve(st, c1, { key, comment: 'Согласовано с телефона' });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.approval.id).toBe(approval1);
    const second = await approve(st, c1, { etag: r.headers.etag as string });
    expect(second.status).toBe(409);
    expect(second.body.current).toMatchObject({ reason: 'already_approved', approvalId: approval1 });
    const row = (await st.db.pool.query('SELECT gate, input_version, approved_by FROM approval WHERE id = $1', [approval1])).rows[0];
    expect(row.approved_by).toBe(st.e.s.ids.manager);
    expect((row.gate as { blockers: { code: string }[] }).blockers.map((b) => b.code)).toEqual(['REVIEW_UNCERTAIN', 'FIELDS_INCOMPLETE']);
    c1 = await view(st, c1.id, st.e.s.eng1);
    expect(c1.can).toMatchObject({ approve: false, release: true });
  });
});

describe('выпуск (I01, I02, A08, A26, RT-07)', () => {
  it('руководитель не выпускает — 403; выпуск с чужим согласованием — APPROVAL_NOT_ACTIVE; вставка выпуска руководителем — 42501', async () => {
    expect((await release(st, c1, approval1, { client: st.e.s.manager })).status).toBe(403);
    const r = await release(st, c1, c1.id);
    expect(r.status, r.text).toBe(409);
    expect(codes(r.body as never)).toContain('APPROVAL_NOT_ACTIVE');
    expect(await pgCode(
      `INSERT INTO release (candidate_id, approval_id, tender_id, stage_id, mode, input_version, content_hash, release_manifest_blob_sha256, release_manifest_sha256, gate, released_by)
       VALUES ($1, $2, $3, $4, 'test', 0, $5, $5, $5, '{}', $6)`,
      [c1.id, approval1, st.e.s.tenderA, st.e.s.stageA, c1.contentHash, st.e.s.ids.manager],
    )).not.toBe('ok');
  });

  it('источник поступает между проверкой готовности и выпуском — INPUTS_CHANGED, удержание, согласование сохранено; «не влияет» — выпуск', async () => {
    expect(c1.gate.release!.ok).toBe(true);
    await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'Письмо заказчика после согласования.pdf');
    const refused = await release(st, c1, approval1);
    expect(refused.status, refused.text).toBe(409);
    expect(codes(refused.body as never)).toEqual(['INPUTS_CHANGED']);
    const after = await view(st, c1.id);
    expect(after).toMatchObject({ status: 'approved', current: false, approval: { id: approval1, status: 'active' } });
    expect(after.holds.open).toBeGreaterThan(0);
    // Решение «не влияет» событий не порождает (R01-07): версия входов этапа не меняется.
    const before = Number((await st.db.pool.query('SELECT input_version FROM tender_stage WHERE id = $1', [st.e.s.stageA])).rows[0].input_version);
    expect(await notApplicable(st, c1.id, 'Письмо не меняет условий комплекта')).toBeGreaterThan(0);
    expect(Number((await st.db.pool.query('SELECT input_version FROM tender_stage WHERE id = $1', [st.e.s.stageA])).rows[0].input_version)).toBe(before);
    c1 = await view(st, c1.id, st.e.s.eng1);
    const r = await release(st, c1, approval1);
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ status: 'released', release: { mode: 'test', sendReadiness: { state: 'ready', sendable: false, testRelease: true } } });
    release1 = r.body.release.id as string;
  });

  it('манифест выпуска: точные файлы кандидата, согласование, принятые риски, решения по удержаниям, кто и когда; ZIP — те же байты', async () => {
    const m = await st.e.s.eng2.getBuffer(`/releases/${release1}/manifest`);
    expect(m.status).toBe(200);
    const body = m.body as Buffer;
    expect(m.headers['x-content-sha256']).toBe(sha(body));
    const manifest = JSON.parse(body.toString('utf8'));
    expect(manifest).toMatchObject({
      schema: 'kontur-release/1',
      release: { id: release1, mode: 'test', releasedBy: { id: st.e.s.ids.eng1 } },
      candidate: { id: c1.id, contentHash: c1.contentHash },
      approval: { id: approval1, approvedBy: { id: st.e.s.ids.manager }, comment: 'Согласовано с телефона' },
    });
    expect(manifest.acceptedRisks.map((a: { code: string }) => a.code).sort()).toEqual(['FIELDS_INCOMPLETE', 'FIELDS_INCOMPLETE', 'REVIEW_UNCERTAIN']);
    expect(manifest.holds.length).toBeGreaterThan(0);
    expect(manifest.holds.every((h: { decision: string; decidedBy: { id: string } }) => h.decision === 'не влияет' && h.decidedBy.id === st.e.s.ids.manager)).toBe(true);
    const files = new Map(c1.files.map((f) => [f.path, f.sha256]));
    for (const f of manifest.files.filter((x: { role: string }) => x.role !== 'preview')) expect(files.get(f.path)).toBe(f.sha256);
    const zip = await st.e.s.eng2.getBuffer(`/releases/${release1}/archive?set=customer`);
    expect(zip.status).toBe(200);
    const z = new PizZip(zip.body as Buffer);
    const customer = c1.files.filter((f) => f.audience === 'customer');
    expect(Object.keys(z.files).sort()).toEqual(customer.map((f) => f.path).sort());
    for (const f of customer) expect(sha(z.file(f.path)!.asNodeBuffer())).toBe(f.sha256);
  });

  it('повтор выпуска: тот же ключ — тот же выпуск; новый — already_released; одна запись выпуска; согласование выпуска не отзывается', async () => {
    const again = await release(st, c1, approval1, { etag: c1.etag });
    expect(again.status).toBe(409);
    expect(again.body.current).toMatchObject({ reason: 'already_released', releaseId: release1 });
    expect(Number((await st.db.pool.query('SELECT count(*) FROM release WHERE candidate_id = $1', [c1.id])).rows[0].count)).toBe(1);
    const a = (await view(st, c1.id)).approval!;
    const revoke = await st.e.s.manager.post(`/approvals/${a.id}/revoke`, { reason: 'Отзыв после выпуска' }, { headers: { 'If-Match': a.etag, ...idem() } });
    expect(revoke.status).toBe(409);
    expect(revoke.body.current.reason).toBe('already_released');
    expect(await pgCode("UPDATE release SET mode = 'production' WHERE id = $1", [release1])).not.toBe('ok');
  });

  it('новая информация после выпуска удерживает отправку; «влияет» — отправка исключена навсегда, запись выпуска не меняется (I04, RT-07)', async () => {
    await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'Ответ на вопрос после выпуска.pdf');
    let v = await view(st, c1.id);
    expect(v.release!.sendReadiness).toMatchObject({ state: 'held', sendable: false });
    const holds = await openHolds(st, c1.id);
    expect(holds.length).toBeGreaterThan(0);
    const r = await st.e.s.manager.post(`/holds/${holds[0]!.id}/resolve`, { resolution: 'requires_new_candidate', reason: 'Ответ меняет условия КП' }, { headers: { 'If-Match': holds[0]!.etag, ...idem() } });
    expect(r.status, r.text).toBe(200);
    expect(r.body.status).toBe('resolved_requires_new_candidate');
    await notApplicable(st, c1.id, 'Остальные события не влияют');
    v = await view(st, c1.id);
    expect(v.status).toBe('released');
    expect(v.release!.sendReadiness.state).toBe('excluded');
    expect(v.release!.id).toBe(release1);
    // Повторное решение по тому же удержанию — отказ.
    const again = await st.e.s.manager.post(`/holds/${holds[0]!.id}/resolve`, { resolution: 'not_applicable', reason: 'Передумали' }, { headers: { 'If-Match': r.headers.etag as string, ...idem() } });
    expect(again.status).toBe(409);
  });
});

describe('отзыв и возврат (В-13-9)', () => {
  let c2: ICandidate13;
  it('отзыв до выпуска: согласование «отозвано» в истории, кандидат снова готов; выпуск по отозванному — нельзя; новое согласование — новая запись', async () => {
    c2 = await assembled(st);
    // Документы предыдущих сценариев поступили до сборки и не входят в снимок (S13-01): удержания и решение по ним.
    expect(c2.current).toBe(false);
    await notApplicable(st, c2.id, 'Документы прошлых сценариев не меняют комплект');
    c2 = await view(st, c2.id);
    await acceptAll(st, c2);
    c2 = await view(st, c2.id);
    const a1 = await approve(st, c2);
    expect(a1.status, a1.text).toBe(200);
    const first = a1.body.approval;
    const engRevoke = await st.e.s.eng1.post(`/approvals/${first.id}/revoke`, { reason: 'Инженер отзывает' }, { headers: { 'If-Match': first.etag, ...idem() } });
    expect(engRevoke.status).toBe(403);
    const rv = await st.e.s.manager.post(`/approvals/${first.id}/revoke`, { reason: 'Нужно уточнить срок' }, { headers: { 'If-Match': first.etag, ...idem() } });
    expect(rv.status, rv.text).toBe(200);
    expect(rv.body).toMatchObject({ status: 'ready_for_approval', approval: null });
    expect(rv.body.approvals[0]).toMatchObject({ id: first.id, status: 'revoked', revokeReason: 'Нужно уточнить срок' });
    c2 = await view(st, c2.id, st.e.s.eng1);
    const byRevoked = await release(st, c2, first.id);
    expect(byRevoked.status).toBe(409);
    expect(byRevoked.body.current.reason).toBe('not_approved');
    const a2 = await approve(st, c2, { etag: (await view(st, c2.id)).etag });
    expect(a2.status, a2.text).toBe(200);
    expect(a2.body.approval.id).not.toBe(first.id);
    c2 = await view(st, c2.id, st.e.s.eng1);
    const old = await release(st, c2, first.id);
    expect(codes(old.body as never)).toContain('APPROVAL_NOT_ACTIVE');
    const again = await st.e.s.manager.post(`/approvals/${first.id}/revoke`, { reason: 'Повторный отзыв' }, { headers: { 'If-Match': first.etag, ...idem() } });
    expect(again.status).toBe(409);
    const h = await st.e.s.manager.get(`/release-candidates/${c2.id}/history`);
    expect(h.status).toBe(200);
    expect((h.body.items as { action: string }[]).map((x) => x.action).filter((x) => x.startsWith('approv'))).toEqual(['approved', 'approval_revoked', 'approved']);
  });

  it('возврат с причиной: согласованный — сначала отзыв; «возвращён» не согласуется и не выпускается', async () => {
    const v = await view(st, c2.id);
    const early = await st.e.s.manager.post(`/release-candidates/${c2.id}/return`, { reason: 'Вернуть согласованный' }, { headers: { 'If-Match': v.etag, ...idem() } });
    expect(early.status).toBe(409);
    expect(early.body.current.reason).toBe('approved_revoke_first');
    const rv = await st.e.s.manager.post(`/approvals/${v.approval!.id}/revoke`, { reason: 'Перед возвратом' }, { headers: { 'If-Match': v.approval!.etag, ...idem() } });
    expect(rv.status).toBe(200);
    const ret = await st.e.s.manager.post(`/release-candidates/${c2.id}/return`, { reason: 'Исправить срок оплаты' }, { headers: { 'If-Match': rv.headers.etag as string, ...idem() } });
    expect(ret.status, ret.text).toBe(200);
    expect(ret.body).toMatchObject({ status: 'returned', returned: { reason: 'Исправить срок оплаты', holdId: null } });
    const ap = await approve(st, c2, { etag: ret.headers.etag as string });
    expect(ap.status).toBe(409);
    expect(ap.body.current.reason).toBe('not_ready');
  });
});

describe('старое согласование не выдаётся за новое; правка приложения после согласования (A09)', () => {
  it('правка поля после согласования — новый комплект заменяет прежний; его согласование «заменено»; выпуск нового по старому — APPROVAL_NOT_ACTIVE; вставка БД — отказ', async () => {
    let c3 = await assembled(st);
    await notApplicable(st, c3.id);
    c3 = await view(st, c3.id);
    await acceptAll(st, c3);
    c3 = await view(st, c3.id);
    const a3 = await approve(st, c3);
    expect(a3.status, a3.text).toBe(200);
    const old = a3.body.approval.id as string;
    // Ручная правка приложения после согласования (A09): новое значение и снова «заполнено».
    const d = await draftOf(st.e.s.eng1, st.drafts.letter);
    const edit = await act(st.e.s.eng1, st.drafts.letter, 'subject', fieldOf(d, 'subject').etag, { action: 'set', value: 'Изменённый предмет предложения', bases: [] });
    expect(edit.status, edit.text).toBe(200);
    if ((await draftOf(st.e.s.eng1, st.drafts.letter)).status !== 'complete') await completeDraft(st.e.s.eng1, st.drafts.letter);
    expect((await view(st, c3.id)).current).toBe(false);
    let c4 = await assembled(st);
    const was = await view(st, c3.id);
    expect(was).toMatchObject({ status: 'superseded', approval: null });
    expect(was.approvals[0]).toMatchObject({ id: old, status: 'superseded' });
    await notApplicable(st, c4.id);
    c4 = await view(st, c4.id);
    await acceptAll(st, c4);
    c4 = await view(st, c4.id);
    const a4 = await approve(st, c4);
    expect(a4.status, a4.text).toBe(200);
    c4 = await view(st, c4.id, st.e.s.eng1);
    const fake = await release(st, c4, old);
    expect(fake.status).toBe(409);
    expect(codes(fake.body as never)).toEqual(['APPROVAL_NOT_ACTIVE']);
    expect((await release(st, was, old)).body.current.reason).toBe('not_approved');
    expect(await pgCode(
      `INSERT INTO release (candidate_id, approval_id, tender_id, stage_id, mode, input_version, content_hash, release_manifest_blob_sha256, release_manifest_sha256, gate, released_by)
       VALUES ($1, $2, $3, $4, 'test', 0, $5, $5, $5, '{}', $6)`,
      [c4.id, old, st.e.s.tenderA, st.e.s.stageA, c4.contentHash, st.e.s.ids.eng1],
    )).not.toBe('ok');

    // Изменение файла после согласования: байты в хранилище подменены — выпуск запрещён (технический блокер).
    const file = c4.files.find((f) => f.audience === 'customer')!;
    const restore = tamperBlob(st, file.sha256);
    try {
      const r = await release(st, c4, a4.body.approval.id as string);
      expect(r.status, r.text).toBe(409);
      expect(codes(r.body as never)).toEqual(['CANDIDATE_CONTENT_MISMATCH']);
      expect((r.body.blockers as { items: { title: string }[] }[])[0]!.items.map((i) => i.title)).toContain(file.path);
    } finally {
      restore();
    }
    expect(await pgCode('UPDATE candidate_file SET size_bytes = size_bytes + 1 WHERE id = $1', [file.id])).not.toBe('ok');
    const ok = await release(st, c4, a4.body.approval.id as string);
    expect(ok.status, ok.text).toBe(201);
  });
});

describe('принятый риск не скрывает вопрос и замечание (A45, D-029 В-09-3)', () => {
  it('отправленный вопрос без ответа и критическое замечание блокируют; принятие риска их не закрывает; они видны в согласовании и манифесте выпуска', async () => {
    const q = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/customer-questions`, { text: 'Подтвердите срок поставки окон' }, { headers: idem() });
    expect(q.status, q.text).toBe(201);
    const sent = await st.e.s.eng1.patch(`/customer-questions/${q.body.id}`, { status: 'sent' }, { headers: { 'If-Match': q.headers.etag as string } });
    expect(sent.status, sent.text).toBe(200);
    const draftQ = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/customer-questions`, { text: 'Черновик вопроса о гарантии' }, { headers: idem() });
    expect(draftQ.status).toBe(201);
    // Критическое замечание ставит только человек (D-029 В-09-7): инженер записывает его по фрагменту ТЗ.
    const fragment = (await st.db.pool.query("SELECT f.id FROM evidence_fragment f WHERE f.text = 'Окраска фасада выполняется в два слоя.' LIMIT 1")).rows[0].id;
    const created = await st.e.s.eng1.post(
      `/stages/${st.e.s.stageA}/findings`,
      { title: 'Окраска фасада в два слоя не учтена в расчёте', severity: 'critical', confidence: 'high', evidence: [{ side: 'left', fragmentId: fragment }] },
      { headers: idem() },
    );
    expect(created.status, created.text).toBe(201);
    const finding = created.body as { id: string };
    // Вопросы — вход проверки (отпечаток содержимого этапа, R09-02): прогон до них устарел (R13-01), нужен новый.
    await rerunReview(st);
    let c5 = await assembled(st);
    await notApplicable(st, c5.id);
    c5 = await view(st, c5.id);
    expect(codes(c5.gate.approve)).toEqual(['REVIEW_UNCERTAIN', 'CRITICAL_FINDINGS_OPEN', 'QUESTIONS_UNANSWERED', 'FIELDS_INCOMPLETE']);
    expect(c5.gate.warnings!.draftQuestions.map((x) => x.id)).toContain(draftQ.body.id);
    await acceptAll(st, c5);
    c5 = await view(st, c5.id);
    expect(c5.gate.approve!.ok).toBe(true);
    // Принятие риска не меняет вопрос и замечание: вопрос «отправлен», замечание критическое и открыто.
    expect(await questionStatus(q.body.id)).toBe('sent');
    expect((await st.e.s.eng1.get(`/findings/${finding.id}`)).body).toMatchObject({ status: 'open', severity: 'critical' });
    expect(c5.gate.approve!.blockers.find((b) => b.code === 'QUESTIONS_UNANSWERED')!.items[0]!.acceptance).not.toBeNull();
    const a5 = await approve(st, c5);
    expect(a5.status, a5.text).toBe(200);
    c5 = await view(st, c5.id, st.e.s.eng1);
    const r = await release(st, c5, a5.body.approval.id as string);
    expect(r.status, r.text).toBe(201);
    const manifest = JSON.parse(((await st.e.s.eng1.getBuffer(`/releases/${r.body.release.id}/manifest`)).body as Buffer).toString('utf8'));
    const risks = manifest.acceptedRisks as { code: string; subjectId: string; reason: string }[];
    expect(risks.find((x) => x.code === 'QUESTIONS_UNANSWERED')).toMatchObject({ subjectId: q.body.id });
    expect(risks.find((x) => x.code === 'CRITICAL_FINDINGS_OPEN')).toMatchObject({ subjectId: finding.id });
    // Изменённый после принятия предмет требует нового принятия (D-033 ут. 3): ответ на вопрос снимает пункт, а не скрывает его.
    expect(await questionStatus(q.body.id)).toBe('sent');
  });
});

describe('боевой режим: ограничения Q-01/X-01, Q-08, Q-05 (RT-05, D-033 В-13-2)', () => {
  it('боевой комплект: CALCULATION_PROVISIONAL, TEMPLATE_DEMO, KP_TOTAL_UNRECONCILED (захват ставит правило итога, D-044) не снимаются ни риском, ни «не влияет»; БД отвергает согласование', async () => {
    let p = await assembled(st, { mode: 'production' });
    await notApplicable(st, p.id);
    p = await view(st, p.id);
    await acceptAll(st, p);
    p = await view(st, p.id);
    expect(codes(p.gate.approve)).toEqual(['CALCULATION_PROVISIONAL', 'TEMPLATE_DEMO', 'KP_TOTAL_UNRECONCILED']);
    expect(p.gate.approve!.blockers.filter((b) => b.open > 0).every((b) => !b.acceptable && b.class === 'integrity')).toBe(true);
    const risk = await acceptRisk(st, p, { blockerCode: 'KP_TOTAL_UNRECONCILED', subjectType: 'candidate', subjectId: p.id, reason: 'Итог КП примем на себя' });
    expect(risk.body.current.reason).toBe('risk_not_acceptable');
    const r = await approve(st, p);
    expect(r.status).toBe(409);
    expect(codes(r.body as never)).toEqual(['CALCULATION_PROVISIONAL', 'TEMPLATE_DEMO', 'KP_TOTAL_UNRECONCILED']);
    expect(await pgCode('INSERT INTO approval (candidate_id, tender_id, stage_id, candidate_content_hash, input_version, gate, approved_by) VALUES ($1, $2, $3, $4, 0, \'{}\', $5)', [
      p.id, st.e.s.tenderA, st.e.s.stageA, p.contentHash, st.e.s.ids.manager,
    ])).toBe('23514');
    // Тестовая сборка не заменяет боевой кандидат (D-033 В-13-6).
    await assembled(st);
    expect((await view(st, p.id)).status).toBe('ready_for_approval');
  });
});

describe('удержание до выпуска: «влияет» возвращает согласованный комплект (D-033 В-13-5)', () => {
  it('новое событие после согласования, решение «влияет» — комплект «возвращён», согласование отозвано с причиной; история', async () => {
    let c = await assembled(st);
    await notApplicable(st, c.id);
    c = await view(st, c.id);
    await acceptAll(st, c);
    c = await view(st, c.id);
    const a = await approve(st, c);
    expect(a.status, a.text).toBe(200);
    await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'Изменение ТЗ после согласования.pdf');
    await drain(st.e.worker);
    const holds = await openHolds(st, c.id);
    expect(holds.length).toBeGreaterThan(0);
    const r = await st.e.s.manager.post(`/release-candidates/${c.id}/holds/resolve`, { holdIds: holds.map((h) => h.id), resolution: 'requires_new_candidate', reason: 'ТЗ изменилось' }, { headers: idem() });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'returned', approval: null, returned: { holdId: expect.any(String) } });
    // Отзыв и возврат ссылаются на событие; причина — в решении по удержанию, закрытом вместе с предметом (R13-02).
    expect(r.body.approvals[0]).toMatchObject({ status: 'revoked', revokeReason: expect.stringContaining('влияет событие №') });
    expect(r.body.approvals[0].revokeReason).not.toContain('ТЗ изменилось');
    const h = (await st.e.s.manager.get(`/release-candidates/${c.id}/history`)).body.items as { action: string; basis: string | null }[];
    expect(h.map((x) => x.action)).toEqual(expect.arrayContaining(['approved', 'hold_requires_new_candidate', 'approval_revoked', 'returned']));
    expect(h.find((x) => x.action === 'hold_requires_new_candidate')!.basis).toContain('ТЗ изменилось');
  });
});
