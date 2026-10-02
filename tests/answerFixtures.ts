// Фикстуры ответного ядра (этап 08a): тендерный этап с документами (распознанный текст по страницам), рабочий состав,
// построенный индекс поиска и worker с поддельной моделью. Сценарий модели задаётся тестом: ответ подменяется целиком
// (ложная цитата, неверное число, отказ, невалидный JSON) или остаётся детерминированная эвристика FakeChat.
import { expect } from 'vitest';
import type { IAppConfig } from '../packages/config/src/index.ts';
import { FakeChat, type ChatModelResult, type IChatCompleteInput } from '../packages/adapters/src/index.ts';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { buildScenario, drain, idem, makeApp, type IScenario, type ITestDb, type TestClient } from './helpers.ts';
import { workerWithChat } from './requirementFixtures.ts';
import { buildIndex, fragmentIdOf, seedEvidenceRun, setWorkingSet, uploadDocument, type IRunSpec } from './searchFixtures.ts';

export type ScriptFn = (input: IChatCompleteInput, call: number) => ChatModelResult<string> | null;

// Модель со сменным сценарием: null — эвристика FakeChat; inputs — все запросы (для проверки входа модели).
export class ScriptedChat extends FakeChat {
  scenario: ScriptFn | null = null;
  readonly inputs: IChatCompleteInput[] = [];
  private scripted = 0;
  constructor(maxInputChars = 4000) {
    super({ maxInputChars, revision: 'test' });
  }
  override async complete(input: IChatCompleteInput) {
    this.inputs.push(input);
    this.scripted += 1;
    const answer = this.scenario?.(input, this.scripted) ?? null;
    if (!answer) return super.complete(input);
    if (!answer.ok) return answer;
    const now = new Date();
    return { ok: true as const, value: { content: answer.value, startedAt: now, finishedAt: now, promptTokens: null, completionTokens: null } };
  }
}

export const draftJson = (claims: { text: string; kind?: string; evidence: string[] }[]): ChatModelResult<string> => ({
  ok: true,
  value: JSON.stringify({ claims: claims.map((c, i) => ({ claim_id: `c${i + 1}`, text: c.text, kind: c.kind ?? 'fact', evidence_ids: c.evidence })), summary: 's', open_questions: [] }),
});

// Метка основания по тексту — из входа последнего запроса черновика.
export const labelOf = (chat: ScriptedChat, includes: string): string => {
  const input = [...chat.inputs].reverse().find((i) => i.task === 'answer_draft');
  const evidence = (JSON.parse(input!.user) as { evidence: { label: string; text: string }[] }).evidence;
  const e = evidence.find((x) => x.text.includes(includes));
  if (!e) throw new Error(`основание «${includes}» не в пакете: ${evidence.map((x) => x.text.slice(0, 40)).join(' | ')}`);
  return e.label;
};

export interface IAnswerStage {
  s: IScenario;
  app: ReturnType<typeof makeApp>;
  worker: WorkerRuntime;
  chat: ScriptedChat;
  revisions: Record<string, string>;
  runs: Record<string, string>;
}

// Тендер A, этап A: документы с заданным текстом в рабочем составе этапа, индекс построен.
export const buildAnswerStage = async (db: ITestDb, config: IAppConfig, docs: Record<string, IRunSpec>, o: { chat?: ScriptedChat | null } = {}): Promise<IAnswerStage> => {
  const app = makeApp(db, undefined, config);
  const s = await buildScenario(db, app);
  const chat = o.chat === undefined ? new ScriptedChat(config.chatModel.maxInputChars) : o.chat;
  const worker = workerWithChat(db, config, chat);
  const revisions: Record<string, string> = {};
  const runs: Record<string, string> = {};
  for (const [name, spec] of Object.entries(docs)) {
    revisions[name] = await uploadDocument(db, config, s.eng1, s.stageA, name);
    runs[name] = await seedEvidenceRun(db.pool, revisions[name]!, spec);
  }
  await setWorkingSet(s.manager, s.stageA, Object.values(revisions));
  await buildIndex(db, worker);
  return { s, app, worker, chat: chat ?? new ScriptedChat(), revisions, runs };
};

export const workingContext = (st: { s: IScenario }) => ({ kind: 'tender', tenderId: st.s.tenderA, mode: 'working', stageId: st.s.stageA });

export const newDialog = async (client: TestClient, context: object, title?: string): Promise<string> => {
  const r = await client.post('/dialogs', { context, ...(title ? { title } : {}) }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body.id as string;
};

export const askQuestion = async (client: TestClient, dialogId: string, text: string): Promise<string> => {
  const r = await client.post(`/dialogs/${dialogId}/messages`, { text }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body.runId as string;
};

// Вопрос и ответ: задание выполняется worker, интерфейс опрашивает готовый прогон.
export const ask = async (st: IAnswerStage, client: TestClient, dialogId: string, text: string, worker: WorkerRuntime = st.worker) => {
  const runId = await askQuestion(client, dialogId, text);
  await drain(worker);
  const r = await client.get(`/answer-runs/${runId}`);
  expect(r.status, r.text).toBe(200);
  return r.body as AnswerView;
};

export interface IEvidenceView {
  number: number | null;
  label: string;
  fragmentId: string;
  versionNote: 'current' | 'superseded' | 'conflict';
  restricted: boolean;
  text: string | null;
}

export interface AnswerView {
  id: string;
  status: string;
  answerStatus: string | null;
  incompleteReason: string | null;
  verificationLevel: string | null;
  failureCode: string | null;
  coverage: Record<string, unknown>;
  answer: {
    visible: boolean;
    text: string | null;
    citations: IEvidenceView[];
    claims: { kind: string; text: string; citations: number[] }[];
    shownClaims: number;
    droppedClaims: number;
    droppedIssues: Record<string, number>;
    foundFragments: IEvidenceView[];
    conflictCitations: number[];
  } | null;
}

export { fragmentIdOf };
