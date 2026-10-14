// npm run model:live-smoke [-- --runs 5] [--load "<что ещё нагружает GPU>"] [--out <журнал>]
// Живая проверка модели на целевом ПК (этап 17, проект §7.5, §13.2): те же адаптеры, что у worker, синтетические
// тексты без данных тендеров. Генеративная модель — /chat/completions; модель эмбеддингов — проба и пачка /embeddings.
// Список моделей сервера (GET /models) — только имена. Запросы последовательны, как у портала (слот GPU = 1); задержка
// p50 и максимум, тайм-ауты и отказы. --load — заметка о параллельной нагрузке (например, «агент MailHub отвечает на
// письма»): прогон повторяют без нагрузки и под нагрузкой и сравнивают. Адреса и ключи в журнал не пишутся.
// Код выхода: 0 — PASS, 1 — FAIL, 3 — NOT_RUN (модель не настроена как openai_compatible).
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createChatModel, OpenAiCompatibleEmbeddings } from '../packages/adapters/src/index.ts';
import { buildId, loadConfig } from '../packages/config/src/index.ts';
import { argValue } from './cli.ts';

const ROOT = resolve(import.meta.dirname, '..');
const RUNS = Number(argValue('runs') ?? '5');
const lines: string[] = [];
let failed = false;
const ln = (status: 'PASS' | 'FAIL' | 'INFO' | 'NOT_RUN', step: string, note = ''): void => {
  if (status === 'FAIL') failed = true;
  const s = `${status.padEnd(7)} ${step}${note ? ` — ${note}` : ''}`;
  lines.push(s);
  console.log(s);
};
const pct = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;

const listModels = async (base: string, key: string | null): Promise<string[] | string> => {
  try {
    const r = await fetch(`${base.replace(/\/+$/u, '')}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return `HTTP ${r.status}`;
    const body = (await r.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
  } catch (err) {
    return (err as Error).name;
  }
};

const main = async (): Promise<number> => {
  const config = loadConfig();
  const chatOn = config.chatModel.provider === 'openai_compatible';
  const embOn = config.embedding.provider === 'openai_compatible';
  lines.push(`# model live-smoke — ${new Date().toISOString()}, ${hostname()}`);
  lines.push(`# Режим: LIVE; Сборка: ${buildId() ?? 'не задана'}; нагрузка рядом: ${argValue('load') ?? 'не указана'}`);
  if (!chatOn && !embOn) {
    ln('NOT_RUN', 'модель не настроена', 'MODEL_PROVIDER и EMBEDDING_PROVIDER не openai_compatible');
    return 3;
  }
  if (chatOn) {
    const models = await listModels(config.chatModel.baseUrl!, config.chatModel.apiKey);
    ln(Array.isArray(models) ? 'INFO' : 'FAIL', 'список моделей сервера (генеративная)', Array.isArray(models) ? `${models.length}: ${models.join(', ')}` : models);
    if (Array.isArray(models)) ln(models.includes(config.chatModel.model!) ? 'PASS' : 'FAIL', `модель ${config.chatModel.model} есть на сервере`);
    const chat = createChatModel(config.chatModel)!;
    const times: number[] = [];
    let errors = 0;
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = Date.now();
      const r = await chat.complete({
        task: 'answer_draft',
        system: 'Ответь одним JSON-объектом {"answer": "<строка>"} без пояснений.',
        user: JSON.stringify({ question: `Сколько дней в неделе? Проверка ${i + 1}.` }),
      });
      times.push(Date.now() - t0);
      if (!r.ok) {
        errors += 1;
        ln('FAIL', `запрос ${i + 1}`, `${r.error.code}: ${r.error.message}`);
      } else if (!r.value.content.trim()) {
        errors += 1;
        ln('FAIL', `запрос ${i + 1}`, 'пустой ответ');
      }
    }
    ln(errors === 0 ? 'PASS' : 'FAIL', `генеративная модель: ${RUNS} запросов`, `p50 ${pct(times, 50)} мс, максимум ${Math.max(...times)} мс, отказов ${errors}`);
  } else ln('NOT_RUN', 'генеративная модель', 'MODEL_PROVIDER не openai_compatible');
  if (embOn) {
    const e = config.embedding;
    const emb = new OpenAiCompatibleEmbeddings({ baseUrl: e.baseUrl!, model: e.model!, revision: e.revision, apiKey: e.apiKey, timeoutMs: e.timeoutMs, batchSize: e.batchSize, expectedDim: e.dim });
    const probe = await emb.probe();
    ln(probe.ok ? 'PASS' : 'FAIL', 'проба модели эмбеддингов', probe.ok ? `размерность ${probe.value.dim}` : `${probe.error.code}: ${probe.error.message}`);
    const texts = Array.from({ length: e.batchSize }, (_, i) => `Раздел ${i + 1}. Бетон класса B25 для монолитных конструкций, армирование А500С.`);
    const times: number[] = [];
    let errors = 0;
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = Date.now();
      const r = await emb.embed({ texts, purpose: 'index' });
      times.push(Date.now() - t0);
      if (!r.ok) errors += 1;
    }
    ln(errors === 0 ? 'PASS' : 'FAIL', `эмбеддинги: ${RUNS} пачек по ${e.batchSize}`, `p50 ${pct(times, 50)} мс, максимум ${Math.max(...times)} мс, отказов ${errors}; бюджет шага index.embed — цель 2 с (ADR-004 §7a)`);
  } else ln('NOT_RUN', 'модель эмбеддингов', 'EMBEDDING_PROVIDER не openai_compatible');
  return failed ? 1 : 0;
};

const code = await main().catch((err: unknown) => {
  ln('FAIL', 'прогон прерван', err instanceof Error ? err.message : 'unknown');
  return 1;
});
lines.push(`Итог: ${code === 0 ? 'PASS' : code === 3 ? 'NOT_RUN' : 'FAIL'}`);
const out = resolve(argValue('out') ?? join(ROOT, 'artifacts', 'stage-17', 'target', `model-live-${hostname()}.log`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(lines.at(-1));
process.exitCode = code;
