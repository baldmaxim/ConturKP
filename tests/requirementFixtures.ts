// Фикстуры этапа 08: тендер с документом ТЗ (распознанный текст по страницам), замороженный набор, снимок
// области и первый реестр требований — через API, как это делает пользователь. Тексты синтетические.
import { expect } from 'vitest';
import type { IAppConfig } from '../packages/config/src/index.ts';
import { HANDLERS } from '../apps/worker/src/handlers/index.ts';
import { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import type { IModelGatewayChat } from '../packages/adapters/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { buildScenario, idem, makeApp, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { fixScope, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument } from './searchFixtures.ts';

export const T = {
  facade: 'Фасад должен быть облицован клинкерным кирпичом.',
  waterproofing: 'Требуется гидроизоляция фундаментной плиты обмазочным составом.',
  note: 'Пояснительная записка к проекту.',
  roof: 'Кровля выполняется из профнастила С-44.',
  advance: 'Аванс составляет 30 процентов цены договора.',
};

export interface IStage08 {
  s: IScenario;
  app: ReturnType<typeof makeApp>;
  docRev: string;
  runId: string;
  scopeId: string;
  registryId: string;
  frag: Record<'facade' | 'waterproofing' | 'note' | 'roof' | 'advance', string>;
}

export const etag = async (client: TestClient, path: string): Promise<string> => {
  const r = await client.get(path);
  expect(r.status, r.text).toBe(200);
  return r.headers.etag as string;
};

// Тендер A, этап A: документ ТЗ на двух страницах, замороженный набор, снимок, реестр № 1 (руководитель).
export const buildStage08 = async (db: ITestDb, config: IAppConfig): Promise<IStage08> => {
  const app = makeApp(db, undefined, config);
  const s = await buildScenario(db, app);
  const docRev = await uploadDocument(db, config, s.eng1, s.stageA, 'тз.pdf');
  const runId = await seedEvidenceRun(db.pool, docRev, {
    pages: [{ blocks: [T.facade, T.waterproofing, T.note] }, { blocks: [T.roof, { text: T.advance, origin: 'document_text' }] }],
  });
  await setWorkingSet(s.manager, s.stageA, [docRev], true);
  const scopeId = await fixScope(s.manager, s.stageA);
  const reg = await s.manager.post(`/stages/${s.stageA}/requirement-registries`, { evidenceScopeId: scopeId, reason: 'Первичный реестр этапа' }, { headers: idem() });
  expect(reg.status, reg.text).toBe(201);
  const frag = {
    facade: await fragmentIdOf(db.pool, runId, T.facade),
    waterproofing: await fragmentIdOf(db.pool, runId, T.waterproofing),
    note: await fragmentIdOf(db.pool, runId, T.note),
    roof: await fragmentIdOf(db.pool, runId, T.roof),
    advance: await fragmentIdOf(db.pool, runId, T.advance),
  };
  return { s, app, docRev, runId, scopeId, registryId: reg.body.id as string, frag };
};

export const supports = (...fragmentIds: string[]) => fragmentIds.map((fragmentId) => ({ fragmentId, role: 'supports' }));

export const propose = async (client: TestClient, registryId: string, statement: string, evidence: object[], extra: Record<string, unknown> = {}) => {
  const r = await client.post(`/requirement-registries/${registryId}/requirement-candidates`, { statement, evidence, ...extra }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body as { id: string; status: string; statement: string | null };
};

export const confirm = async (client: TestClient, candidateId: string, body: object = {}) =>
  client.post(`/requirement-candidates/${candidateId}/confirm`, body, { headers: { 'If-Match': await etag(client, `/requirement-candidates/${candidateId}`), ...idem() } });

// Предложение инженера и подтверждение руководителем: возвращает требование.
export const confirmedRequirement = async (st: IStage08, statement: string, fragmentIds: string[]) => {
  const c = await propose(st.s.eng1, st.registryId, statement, supports(...fragmentIds));
  const r = await confirm(st.s.manager, c.id);
  expect(r.status, r.text).toBe(200);
  return { candidateId: c.id, requirementId: r.body.requirementId as string, revisionId: r.body.revisionId as string };
};

// Worker с заданной генеративной моделью (сценарии отказов и ответов).
export const workerWithChat = (db: ITestDb, config: IAppConfig, chat: IModelGatewayChat | null, workerId = 'test-worker-08'): WorkerRuntime =>
  new WorkerRuntime({ pool: db.pool, store: new BlobStore(config.storageRoot), config, handlers: HANDLERS, workerId, chat });
