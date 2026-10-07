// Фикстуры этапа 13 (D-033): этап A с поддельным TenderHub (две ревизии расчёта, VERIFIED_FIXTURE, не рабочая
// интеграция), ТЗ из двух фрагментов, реестр с двумя подтверждёнными требованиями — одно покрыто строкой расчёта, у
// второго оценки покрытия нет (пробел покрытия по обработанным данным — снимаемый `REVIEW_UNCERTAIN`), факты извлечены,
// поддельная модель отвечает без гипотез. Прогон проверок завершён без пробелов обработки; демо-шаблоны с размеченными
// образцами, «заполненные» приложения, тестовый комплект собирается на настоящем worker и LibreOffice.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';
import { compareWithCalculation } from '../packages/core/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { buildEcon, closeEcon, E, type IEcon } from './economicsFixtures.ts';
import { createDraft, demoSchema, fillAll, KEY_FILLED, KP_FILLED } from './formsFixtures.ts';
import { createTestDb, drain, idem, testConfig, type ITestDb, type TestClient } from './helpers.ts';
import { completeDraft, requireConverter, SAMPLES, templateWithMarkedSample } from './releaseFixtures.ts';
import { etagOf, fakeModel, type IRunView } from './reviewFixtures.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

export const TZ = {
  plaster: 'Штукатурка стен выполняется по всей площади.',
  paint: 'Окраска фасада выполняется в два слоя.',
};

// Строка расчёта «Штукатурка стен» второй ревизии (economicsFixtures: id('d', 1)).
export const PLASTER_LINE = '7d1f0c8e-1010-4a6b-9c1d-d00000000001';

export interface IStage13 {
  db: ITestDb;
  e: IEcon;
  tzRev: string;
  scopeId: string;
  registryId: string;
  run: IRunView;
  letterRevision: string;
  conditionsRevision: string;
  kpPrice: string;
  drafts: { letter: string; conditions: string };
}

export interface ICandidateGateView {
  ok: boolean;
  blockers: {
    code: string;
    class: string;
    acceptable: boolean;
    open: number;
    items: { subjectType: string; subjectId: string; subjectKey: string; subjectVersion: number | null; title: string; acceptable: boolean; acceptance: { id: string; reason: string } | null }[];
  }[];
}

export interface IApprovalView {
  id: string;
  status: string;
  contentHash: string;
  acceptedRiskIds: string[];
  etag: string;
  revokeReason: string | null;
}

export interface ICandidate13 {
  id: string;
  seq: number;
  mode: string;
  status: string;
  etag: string;
  contentHash: string;
  current: boolean;
  restricted: boolean;
  failure: { code: string; detail: string } | null;
  files: { id: string; path: string; audience: string; sha256: string; sizeBytes: number }[];
  previews: { id: string; sha256: string }[];
  gate: { approve: ICandidateGateView | null; release: ICandidateGateView | null; warnings: { draftQuestions: { id: string }[]; emptyOptionalFields: unknown[]; reviewRisks: { findingId: string }[] } | null };
  approval: IApprovalView | null;
  approvals: IApprovalView[];
  release: { id: string; mode: string; manifestSha256: string; sendReadiness: { state: string; sendable: boolean; testRelease: boolean; events: { seq: number; type: string }[] } } | null;
  returned: { reason: string; holdId: string | null } | null;
  holds: { open: number; total: number };
  can: { approve: boolean; acceptRisk: boolean; resolveHolds: boolean; release: boolean };
}

// Модель: гипотез нет (проверка модели «пройдено») или отказ (ошибка обработки); остальные задачи — поведение поддельной
// модели по умолчанию.
const quietModel = (fail = false) =>
  fakeModel((input) =>
    input.task === 'review_hypotheses' ? (fail ? { ok: false, error: { code: 'UNAVAILABLE', message: 'модель недоступна', retryable: false } } : { ok: true, value: '{"hypotheses":[]}' }) : null,
  );

export interface IStage13Options {
  // Прогон проверок: false — не запускать (REVIEW_MISSING).
  review?: boolean;
  // Страница ТЗ не распознана (неполная обработка) и отказ модели (ошибка обработки) — REVIEW_PROCESSING_INCOMPLETE.
  missingPage?: boolean;
  modelError?: boolean;
  config?: Parameters<typeof testConfig>[0];
}

const requirementOf = async (st: { e: IEcon; registryId: string }, statement: string, fragmentId: string): Promise<string> => {
  const c = await st.e.s.eng1.post(
    `/requirement-registries/${st.registryId}/requirement-candidates`,
    { statement, parameters: [], evidence: [{ fragmentId, role: 'supports' }] },
    { headers: idem() },
  );
  expect(c.status, c.text).toBe(201);
  const r = await st.e.s.manager.post(`/requirement-candidates/${c.body.id}/confirm`, {}, { headers: { 'If-Match': await etagOf(st.e.s.manager, `/requirement-candidates/${c.body.id}`), ...idem() } });
  expect(r.status, r.text).toBe(200);
  return r.body.revisionId as string;
};

export const buildStage13 = async (o: IStage13Options = {}): Promise<IStage13> => {
  requireConverter();
  const db = await createTestDb();
  const e = await buildEcon(db, testConfig(o.config ?? {}), { chat: quietModel(o.modelError) });
  const tzRev = await uploadDocument(db, e.config, e.s.eng1, e.s.stageA, 'ТЗ.pdf');
  const pages = [{ blocks: [TZ.plaster, TZ.paint] }];
  const run1 = await seedEvidenceRun(db.pool, tzRev, o.missingPage ? { pages, missingPages: 1 } : { pages });
  await setWorkingSet(e.s.manager, e.s.stageA, [tzRev], true);
  const scopeId = await fixScope(e.s.manager, e.s.stageA);
  const reg = await e.s.manager.post(`/stages/${e.s.stageA}/requirement-registries`, { evidenceScopeId: scopeId, reason: 'Реестр этапа 13' }, { headers: idem() });
  expect(reg.status, reg.text).toBe(201);
  const st = { e, registryId: reg.body.id as string };
  const plaster = await requirementOf(st, 'Штукатурка стен по всей площади', await fragmentIdOf(db.pool, run1, TZ.plaster));
  await requirementOf(st, 'Окраска фасада в два слоя', await fragmentIdOf(db.pool, run1, TZ.paint));
  const cov = await e.s.manager.post(
    `/requirement-revisions/${plaster}/coverage`,
    { state: 'covered', objects: [{ type: 'calculation_revision', calculationRevisionId: e.rev2, externalPositionId: E.q.A, externalItemId: PLASTER_LINE, match: 'explicit_line' }] },
    { headers: idem() },
  );
  expect(cov.status, cov.text).toBe(201);
  const done = await e.s.manager.post(`/requirement-registries/${st.registryId}/reviews`, {}, { headers: idem() });
  expect(done.status, done.text).toBe(201);
  await e.worker.scheduleFactExtraction();
  await drain(e.worker);
  let run = { id: '', status: 'none', checks: [] } as unknown as IRunView;
  if (o.review !== false) {
    const started = await e.s.eng1.post(`/stages/${e.s.stageA}/review-runs`, {}, { headers: idem() });
    expect([200, 201], started.text).toContain(started.status);
    await drain(e.worker);
    run = (await e.s.eng1.get(`/review-runs/${started.body.id}`)).body as IRunView;
  }
  const grand = (await db.pool.query<{ g: string }>('SELECT cc.source_grand_total AS g FROM calculation_revision r JOIN calculation_content cc ON cc.id = r.content_id WHERE r.id = $1', [e.rev2])).rows[0]!.g;
  const m = compareWithCalculation({ unit: 'млн руб.', currency: 'RUB', scale: 2 }, '0', 'source_grand_total', grand);
  const kpPrice = m.outcome === 'unverified' ? '0' : m.expected;
  const letterRevision = (await templateWithMarkedSample(e.s.manager, { name: 'Письмо КП (демо)', schema: demoSchema('demo-kp-letter'), marked: SAMPLES.letterMarked, original: SAMPLES.letterOriginal })).revision.id;
  const conditionsRevision = (
    await templateWithMarkedSample(e.s.manager, { name: 'Ключевые условия (демо)', schema: demoSchema('demo-key-conditions'), marked: SAMPLES.conditionsMarked, original: SAMPLES.conditionsOriginal, audience: 'internal' })
  ).revision.id;
  const out: IStage13 = { db, e, tzRev, scopeId, registryId: st.registryId, run, letterRevision, conditionsRevision, kpPrice, drafts: { letter: '', conditions: '' } };
  out.drafts.letter = await filledDraft(out, 'letter', 'Письмо КП');
  out.drafts.conditions = await filledDraft(out, 'conditions', 'Ключевые условия');
  return out;
};

export const closeStage13 = async (st: IStage13 | undefined): Promise<void> => {
  await closeEcon(st?.e);
  await st?.db.drop();
};

export const filledDraft = async (st: IStage13, key: 'letter' | 'conditions', title: string): Promise<string> => {
  const d = await createDraft(st.e.s.eng1, st.e.s.stageA, key === 'letter' ? st.letterRevision : st.conditionsRevision, title);
  await fillAll(st.e.s.eng1, d.id, key === 'letter' ? { ...KP_FILLED, kp_price: st.kpPrice } : KEY_FILLED);
  await completeDraft(st.e.s.eng1, d.id);
  return d.id;
};

export const view = async (st: IStage13, id: string, client: TestClient = st.e.s.manager): Promise<ICandidate13> => {
  const r = await client.get(`/release-candidates/${id}`);
  expect(r.status, r.text).toBe(200);
  return r.body as ICandidate13;
};

// Сборка комплекта до конца (worker и LibreOffice); по умолчанию — тестовый, письмо и условия.
export const assembled = async (st: IStage13, o: { mode?: 'test' | 'production'; draftIds?: string[] } = {}): Promise<ICandidate13> => {
  const r = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/release-candidates`, { mode: o.mode ?? 'test', draftIds: o.draftIds ?? [st.drafts.letter, st.drafts.conditions] }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  await drain(st.e.worker);
  const v = await view(st, r.body.id as string);
  expect(v.status, JSON.stringify(v.failure)).toBe('ready_for_approval');
  return v;
};

export const approve = (st: IStage13, c: ICandidate13, o: { client?: TestClient; contentHash?: string; etag?: string; key?: Record<string, string>; comment?: string } = {}) =>
  (o.client ?? st.e.s.manager).post(
    `/release-candidates/${c.id}/approve`,
    { contentHash: o.contentHash ?? c.contentHash, ...(o.comment ? { comment: o.comment } : {}) },
    { headers: { 'If-Match': o.etag ?? c.etag, ...(o.key ?? idem()) } },
  );

export const release = (st: IStage13, c: ICandidate13, approvalId: string, o: { client?: TestClient; etag?: string; key?: Record<string, string> } = {}) =>
  (o.client ?? st.e.s.eng1).post(`/release-candidates/${c.id}/release`, { approvalId, contentHash: c.contentHash }, { headers: { 'If-Match': o.etag ?? c.etag, ...(o.key ?? idem()) } });

export const acceptRisk = (st: IStage13, c: ICandidate13, body: { blockerCode: string; subjectType: string; subjectId: string; subjectKey?: string; reason: string }, client: TestClient = st.e.s.manager) =>
  client.post(`/release-candidates/${c.id}/risk-acceptances`, body, { headers: idem() });

// Все пункты бизнес-блокеров оценки согласования — принятие риска руководителем с причиной.
export const acceptAll = async (st: IStage13, c: ICandidate13): Promise<number> => {
  let n = 0;
  for (const b of c.gate.approve?.blockers ?? []) {
    if (!b.acceptable) continue;
    for (const i of b.items.filter((x) => !x.acceptance)) {
      const r = await acceptRisk(st, c, { blockerCode: b.code, subjectType: i.subjectType, subjectId: i.subjectId, subjectKey: i.subjectKey, reason: `Риск принят руководителем: ${i.title}`.slice(0, 2000) });
      expect(r.status, r.text).toBe(201);
      n += 1;
    }
  }
  return n;
};

export const codes = (g: ICandidateGateView | null | undefined): string[] => (g?.blockers ?? []).filter((b) => b.open > 0).map((b) => b.code);

export const openHolds = async (st: IStage13, candidateId: string): Promise<{ id: string; etag: string; event: { seq: number; type: string } }[]> => {
  const r = await st.e.s.manager.get(`/stages/${st.e.s.stageA}/holds?candidateId=${candidateId}&status=open`);
  expect(r.status, r.text).toBe(200);
  return r.body.items;
};

export const notApplicable = async (st: IStage13, candidateId: string, reason = 'Новый документ не относится к комплекту'): Promise<number> => {
  const holds = await openHolds(st, candidateId);
  if (holds.length === 0) return 0;
  const r = await st.e.s.manager.post(`/release-candidates/${candidateId}/holds/resolve`, { holdIds: holds.map((h) => h.id), resolution: 'not_applicable', reason }, { headers: idem() });
  expect(r.status, r.text).toBe(200);
  return holds.length;
};

// Подмена байтов файла в хранилище в обход приложения (имитация изменения файла после согласования, I19).
export const tamperBlob = (st: IStage13, sha256: string): (() => void) => {
  const p = new BlobStore(st.e.config.storageRoot).pathOf(sha256);
  const original = readFileSync(p);
  chmodSync(p, 0o644);
  writeFileSync(p, Buffer.concat([original, Buffer.from(' ')]));
  return () => {
    writeFileSync(p, original);
    chmodSync(p, 0o444);
  };
};
