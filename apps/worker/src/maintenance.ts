// Проход обслуживания поиска (state-machines §20–21). Выполняется worker раз в несколько секунд
// и не зависит от событий: даже если постановка задания где-то потерялась, следующий проход
// восстановит ход индексации. Здесь же — автономная терминализация просроченных прогонов (G05-02).
import type { IModelGatewayEmbeddings } from '@kontur/adapters';
import type { IAppConfig } from '@kontur/config';
import { CHUNKER_VERSION, embeddingInputVersion, MAX_EMBEDDING_DIM, modelFingerprint, probeMatches } from '@kontur/core';
import {
  activateVersion,
  chunksWithoutVectors,
  createVersion,
  degradeIfExpired,
  enqueueIndexBuild,
  enqueueIndexEmbed,
  enqueueIndexPurge,
  expiredPendingRuns,
  getActiveVersion,
  getBuildingVersion,
  parseVector,
  recordModelStatus,
  retiredVersionsToPurge,
  unitsMissingInVersion,
  withTransaction,
  type ISearchIndexVersionRow,
  type IVersionEmbedding,
  type Pool,
} from '@kontur/db';

export interface IMaintenanceDeps {
  pool: Pool;
  config: IAppConfig;
  embeddings: IModelGatewayEmbeddings | null;
  log: (line: string) => void;
}

export interface IMaintenanceReport {
  expiredRuns: number;
  model: 'not_configured' | 'skipped' | 'ok' | 'unavailable' | 'fingerprint_mismatch' | 'dimension_mismatch';
  createdVersion: string | null;
  activated: string | null;
  enqueued: string[];
}

// Желаемая идентичность модели: из настройки и свежего пробного вектора.
const desiredEmbedding = (e: IModelGatewayEmbeddings, templateVersion: string, probe: { dim: number; probe: number[] }): IVersionEmbedding => ({
  inputVersion: templateVersion,
  model: e.model,
  fingerprint: modelFingerprint(e.model, probe.dim, e.revision),
  dim: probe.dim,
  probe: probe.probe,
});

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string }).code === '23505';

export const runSearchMaintenance = async (d: IMaintenanceDeps, o: { checkModel: boolean }): Promise<IMaintenanceReport> => {
  const report: IMaintenanceReport = { expiredRuns: 0, model: 'skipped', createdVersion: null, activated: null, enqueued: [] };

  // 1. Просроченные прогоны — degraded (semantic_timeout) без участия клиента.
  for (const runId of await expiredPendingRuns(d.pool)) {
    if (await withTransaction(d.pool, (c) => degradeIfExpired(c, runId))) report.expiredRuns += 1;
  }

  // 2. Модель: доступность, размерность и пробный вектор (отпечаток, ADR-012 §25).
  let desired: IVersionEmbedding | null = null;
  const verification = d.embeddings ? 'VERIFIED_FIXTURE' : 'NOT_IMPLEMENTED';
  if (!d.embeddings) {
    report.model = 'not_configured';
    // Модель не настроена: смысловая ветка сразу честно недоступна, без заданий, обречённых на отказ.
    if (o.checkModel) await recordModelStatus(d.pool, { ok: false, errorCode: 'model_unavailable', verification, details: { kind: 'none' } });
  } else if (o.checkModel) {
    const probe = await d.embeddings.probe();
    if (!probe.ok) {
      report.model = probe.error.reason === 'dimension_mismatch' ? 'dimension_mismatch' : 'unavailable';
      await recordModelStatus(d.pool, { ok: false, errorCode: probe.error.reason, verification, details: { kind: d.embeddings.kind, model: d.embeddings.model, code: probe.error.code } });
    } else if (probe.value.dim > MAX_EMBEDDING_DIM) {
      report.model = 'dimension_mismatch';
      await recordModelStatus(d.pool, { ok: false, errorCode: 'dimension_mismatch', verification, details: { kind: d.embeddings.kind, model: d.embeddings.model, dim: probe.value.dim } });
    } else {
      desired = desiredEmbedding(d.embeddings, embeddingInputVersion(d.config.embedding.template), probe.value);
      const active = await getActiveVersion(d.pool);
      // Тот же отпечаток, но другой пробный вектор — веса подменены под тем же именем и ревизией.
      const stored = active?.embedding_model_fingerprint === desired.fingerprint ? parseVector(active.probe_vector) : null;
      const mismatch = stored !== null && !probeMatches(stored, probe.value.probe);
      report.model = mismatch ? 'fingerprint_mismatch' : 'ok';
      await recordModelStatus(d.pool, {
        ok: !mismatch,
        errorCode: mismatch ? 'model_fingerprint_mismatch' : null,
        verification,
        details: { kind: d.embeddings.kind, model: d.embeddings.model, dim: probe.value.dim, fingerprint: desired.fingerprint },
      });
      if (mismatch) desired = null;
    }
  }

  // 3. Версии: первая версия; новая версия при появлении или смене модели и при смене нарезки.
  let active = await getActiveVersion(d.pool);
  let building = await getBuildingVersion(d.pool);
  const needsRebuild = (v: ISearchIndexVersionRow): boolean =>
    v.chunker_version !== CHUNKER_VERSION ||
    (desired !== null && (v.embedding_model_fingerprint !== desired.fingerprint || v.embedding_input_version !== desired.inputVersion));
  if (!building && (!active || needsRebuild(active)) && (d.embeddings === null || o.checkModel || !active)) {
    // Без свежей проверки модели версия с моделью не создаётся: строится текстовая, а векторную
    // версию проход создаст, когда модель ответит.
    try {
      const id = await createVersion(d.pool, { chunkerVersion: CHUNKER_VERSION, embedding: desired, createdBy: null });
      report.createdVersion = id;
      d.log(`создана версия индекса поиска ${id} (${desired ? `модель ${desired.model}, размерность ${desired.dim}` : 'без векторов'})`);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    active = await getActiveVersion(d.pool);
    building = await getBuildingVersion(d.pool);
  }

  // 4. Ход индексации живых версий: недостающие единицы и векторы.
  for (const v of [building, active]) {
    if (!v) continue;
    if ((await unitsMissingInVersion(d.pool, v.id, 1)).length > 0) {
      const j = await enqueueIndexBuild(d.pool, v.id);
      if (j.created) report.enqueued.push(`index.build:${v.seq}`);
    }
    if (v.embedding_model && d.embeddings && (await chunksWithoutVectors(d.pool, v.id, 1)).length > 0) {
      const j = await enqueueIndexEmbed(d.pool, v.id);
      if (j.created) report.enqueued.push(`index.embed:${v.seq}`);
    }
  }

  // 5. Активация полной строящейся версии.
  if (building) {
    const a = await activateVersion(d.pool, building.id);
    if (a.activated) {
      report.activated = building.id;
      d.log(`версия индекса поиска ${building.seq} активирована`);
    }
  }

  // 6. Данные выведенных версий без ожидающих прогонов.
  for (const id of await retiredVersionsToPurge(d.pool)) {
    const j = await enqueueIndexPurge(d.pool, id);
    if (j.created) report.enqueued.push(`index.purge:${id}`);
  }
  return report;
};
