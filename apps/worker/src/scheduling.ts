// Планирование заданий worker по состоянию БД (ADR-004): инвалидация, извлечение фактов, сканы папок, выгрузки
// расчёта по сроку, локальное распознавание. Вынесено из runtime.ts (этап 17); вызывается проходом обслуживания очереди.
import { describeLocalRecognizer, localSettings, type ILocalOcrEngineFactory, type LocalInputFormat } from '@kontur/adapters';
import type { IAppConfig } from '@kontur/config';
import {
  autoRecognitionCandidates,
  dueChannels,
  dueDeadlineCaptures,
  enqueueFactExtraction,
  enqueueInvalidation,
  enqueueJob,
  enqueueLocalRecognition,
  eventsAwaitingInvalidation,
  markScanStarted,
  recognizerFingerprint,
  requestCapture,
  runsAwaitingExtraction,
  withTransaction,
  type FingerprintByFormat,
  type Pool,
} from '@kontur/db';

// Инвалидация (этап 09, §5.4): каждое необработанное событие барьера получает задание `stage.invalidate` (dedupe —
// одно на событие). Барьер от задания не зависит: устаревание прогона видно сразу по версии входов.
export const scheduleStageInvalidation = async (pool: Pool): Promise<number> => {
  const events = await eventsAwaitingInvalidation(pool);
  for (const e of events) await enqueueInvalidation(pool, e.id, e.tender_id);
  return events.length;
};

// Извлечение фактов D-018 (D-028): предпочтительные завершённые прогоны распознавания документов тендера и договора
// без извлечения текущей версии правил получают задание `fact.extract` (dedupe — одно на прогон).
export const scheduleFactExtraction = async (pool: Pool): Promise<number> => {
  const runs = await runsAwaitingExtraction(pool);
  for (const r of runs) await enqueueFactExtraction(pool, r.id, r.tender_id);
  return runs.length;
};

// Каналы, которым пора сканировать, получают задание (dedupe — одно активное на канал).
export const scheduleScans = async (pool: Pool): Promise<number> => {
  const due = await dueChannels(pool);
  for (const ch of due) {
    await withTransaction(pool, async (client) => {
      await enqueueJob(client, { kind: 'intake.scan', dedupeKey: `scan:${ch.id}`, payload: { channelId: ch.id }, tenderId: ch.tender_id, resourceClass: 'network' });
      await markScanStarted(client, ch.id);
    });
  }
  return due.length;
};

// Срок подачи из TenderHub наступил — выгрузка расчёта (ADR-007 §7): сигнал, а не закрытие. Ставится
// один раз на срок; ревизия остаётся provisional. Без настроенного TenderHub не планируется.
export const scheduleCalculationCaptures = async (pool: Pool, config: IAppConfig, log: (line: string) => void): Promise<number> => {
  const th = config.tenderhub;
  if (!th.baseUrl || !th.apiKey) return 0;
  let scheduled = 0;
  for (const d of await dueDeadlineCaptures(pool)) {
    try {
      await withTransaction(pool, async (client) => {
        await requestCapture(client, {
          stageId: d.stage_id,
          tenderId: d.tender_id,
          source: { id: d.source_id, external_tender_id: d.external_tender_id },
          trigger: 'deadline',
          requestedBy: null,
          deadlineBasis: d.deadline,
          maxAttempts: th.captureAttempts,
        });
      });
      scheduled += 1;
    } catch (err) {
      // Параллельная выгрузка того же этапа уже идёт (уникальность) — следующий проход решит сам.
      log(`выгрузка по сроку для этапа ${d.stage_id} не поставлена: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
  return scheduled;
};

// Автоматическая постановка локального распознавания (OD-2): DOCX, XLSX, CSV и PDF с политикой local
// без успешного локального прогона и без прогона текущей идентичности. PDF с политикой auto сюда
// не попадает никогда — его распознаёт только явная команда (OD-1).
export const scheduleLocalRecognition = async (
pool: Pool,
config: IAppConfig,
localOcr: ILocalOcrEngineFactory | null,
log: (line: string) => void,
): Promise<number> => {
  const settings = localSettings(config, localOcr);
  const formats: LocalInputFormat[] = ['pdf', 'docx', 'xlsx', 'csv'];
  const descriptors = new Map<LocalInputFormat, Awaited<ReturnType<typeof describeLocalRecognizer>>>();
  const fps: Partial<FingerprintByFormat> = {};
  for (const f of formats) {
    const d = await describeLocalRecognizer(f, settings);
    descriptors.set(f, d);
    fps[f] = await recognizerFingerprint(pool, d);
  }
  let created = 0;
  for (const c of await autoRecognitionCandidates(pool, fps as FingerprintByFormat, config.localRecognition.autoBatch)) {
    try {
      const out = await withTransaction(pool, (client) =>
        enqueueLocalRecognition(client, { revisionId: c.revision_id, descriptor: descriptors.get(c.input_format)!, createdBy: null }),
      );
      if (out.kind === 'created') created += 1;
    } catch (err) {
      // Гонка с приёмом RDWeb или командой пользователя: охранник БД отказал — следующий проход решит сам.
      log(`локальное распознавание редакции ${c.revision_id} не поставлено: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
  return created;
};
