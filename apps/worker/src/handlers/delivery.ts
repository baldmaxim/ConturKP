// Размещение выпуска в назначение (этап 14; D-034; проект §5). Проверки до записи — целостность байтов (A27), набор
// файлов против признака готовности и пути (A38); затем общий алгоритм placeFolder (адаптер): каждый шаг идемпотентен
// и начинается со сверки, перенос — без замены, признак готовности — последним и без перезаписи. Неизвестный исход
// (истёк срок записи или переноса) — только сверка при следующем запуске (A29). Отказ одного назначения не затрагивает
// другие (A28). Проверка доступа назначения — под учётной записью worker (D-034).
import { DeliveryAdapterError, FsDeliveryTarget, PlacementConflict, placeFolder, type IDeliveryFs } from '@kontur/adapters';
import {
  isPathInside,
  tenderCapabilities,
  type IReleaseManifest,
  PLACEMENT_MARKER,
  placementBytes,
  placementSha256,
  relativePathProblem,
  rootPathProblem,
  segmentProblem,
} from '@kontur/core';
import {
  candidateVisibleTo,
  deliveryResponsibleUser,
  fileStates,
  getDelivery,
  getRelease,
  loadAccessContext,
  memberRoleOf,
  releaseManifestReadableBy,
  getDestinationVersion,
  insertAttempt,
  insertProbe,
  setDeliveryStatus,
  setFileState,
  type IDeliveryFileStateRow,
  type IDeliveryRow,
  type IDestinationVersionRow,
} from '@kontur/db';
import { PermanentJobError, RetryableJobError, type IJobContext, type IJobHandlerSpec } from '../runtime.ts';

const WORKING = new Set(['pending', 'staging', 'committing', 'verifying', 'outcome_unknown']);
// Порядок рабочих шагов: после перезапуска статус не откатывается назад (проверка §3 — вторая линия).
const STEP: Record<string, number> = { staging: 1, committing: 2, verifying: 3 };

const fsOf = (ctx: IJobContext): IDeliveryFs => ctx.deliveryFs;

const targetOf = (ctx: IJobContext, kind: IDeliveryRow['kind'], v: IDestinationVersionRow): FsDeliveryTarget =>
  new FsDeliveryTarget({ kind, rootPath: v.root_path, stagingPath: v.staging_path, fs: fsOf(ctx), timeoutMs: ctx.config.delivery.operationTimeoutMs });

// Пути закреплённой версии и доставки (A38): отказ до любой записи.
const pathProblem = (d: IDeliveryRow, v: IDestinationVersionRow, files: readonly IDeliveryFileStateRow[]): string | null => {
  const root = rootPathProblem(v.root_path);
  if (root) return `корень: ${root}`;
  const staging = rootPathProblem(v.staging_path);
  if (staging) return `служебная папка: ${staging}`;
  if (d.kind === 'yandex_disk' && (isPathInside(v.staging_path, v.root_path) || isPathInside(v.root_path, v.staging_path))) {
    return 'служебная папка Яндекс Диска должна быть вне папки синхронизации';
  }
  const folder = relativePathProblem(d.target_folder);
  if (folder) return `папка выпуска: ${folder}`;
  for (const f of files) {
    const p = segmentProblem(f.path);
    if (p) return `файл «${f.path.slice(0, 60)}»: ${p}`;
  }
  return null;
};

// Набор файлов доставки — ровно файлы признака готовности, признак — с закреплённым отпечатком (A27; вторая линия — 0038).
const setMatchesPlacement = (d: IDeliveryRow, files: readonly IDeliveryFileStateRow[]): boolean => {
  const key = (p: string, sha: string, size: number) => `${p}\u0000${sha}\u0000${size}`;
  const payload = files.filter((f) => f.kind !== 'marker').map((f) => key(f.path, f.sha256, Number(f.size_bytes))).sort();
  const listed = d.placement.files.map((f) => key(f.path, f.sha256, f.size)).sort();
  const markers = files.filter((f) => f.kind === 'marker');
  return (
    payload.length === listed.length &&
    payload.every((x, i) => x === listed[i]) &&
    markers.length === 1 &&
    markers[0]!.path === PLACEMENT_MARKER &&
    markers[0]!.sha256 === d.placement_sha256 &&
    Number(markers[0]!.size_bytes) === placementBytes(d.placement).length
  );
};

// Внутренний набор несёт манифест выпуска с причинами решений (Review 14-1 R14-01): перед записью — текущее право того,
// кто запросил размещение (иначе — выпустившего): активен, delivery.manage по тендеру, видит комплект, читает манифест.
const internalSetAllowed = async (ctx: IJobContext, d: IDeliveryRow): Promise<boolean> => {
  const userId = await deliveryResponsibleUser(ctx.pool, d.id);
  const access = userId ? await loadAccessContext(ctx.pool, userId, `job:${ctx.job.id}`) : null;
  if (!access || !tenderCapabilities(access.roles, memberRoleOf(access, d.tender_id)).includes('delivery.manage')) return false;
  const release = await getRelease(ctx.pool, d.release_id);
  if (!release || !(await candidateVisibleTo(ctx.pool, access, release.candidate_id))) return false;
  const chunks: Buffer[] = [];
  for await (const chunk of ctx.store.openRead(release.release_manifest_blob_sha256)) chunks.push(chunk as Buffer);
  return releaseManifestReadableBy(ctx.pool, access, release, JSON.parse(Buffer.concat(chunks).toString('utf8')) as IReleaseManifest);
};

export const deliveryPlaceHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const id = String(ctx.job.payload.deliveryId);
    const startedAt = new Date();
    const d = await ctx.withLease((c) => getDelivery(c, id));
    if (!d || !WORKING.has(d.status)) return;
    const version = (await getDestinationVersion(ctx.pool, d.destination_version_id))!;
    const files = await fileStates(ctx.pool, id);
    let current = d.status === 'pending' || d.status === 'outcome_unknown' ? 'staging' : d.status;
    await ctx.withLease((c) => setDeliveryStatus(c, id, { status: current, attempt: true }));
    const advance = async (to: 'committing' | 'verifying') => {
      if ((STEP[current] ?? 0) >= STEP[to]!) return;
      current = to;
      await ctx.withLease((c) => setDeliveryStatus(c, id, { status: to }));
    };
    const state = async (f: IDeliveryFileStateRow, s: IDeliveryFileStateRow['remote_state'], sha: string | null) => {
      await ctx.withLease((c) => setFileState(c, id, f.ordinal, s, sha));
    };
    try {
      // 1. Целостность (A27): байты хранилища совпадают с выпуском.
      for (const f of files.filter((x) => x.kind !== 'marker')) {
        const ok = await ctx.store.verify(f.sha256).catch(() => false);
        if (!ok) throw new PermanentJobError('CONTENT_MISMATCH', `байты файла «${f.path.slice(0, 60)}» в хранилище не совпадают с выпуском`);
      }
      if (placementSha256(d.placement) !== d.placement_sha256) throw new PermanentJobError('CONTENT_MISMATCH', 'признак готовности не совпадает с закреплённым');
      if (!setMatchesPlacement(d, files)) throw new PermanentJobError('CONTENT_MISMATCH', 'набор файлов доставки не совпадает с признаком готовности');
      // Право на внутренний набор — текущее, до любой записи (R14-01).
      if (d.file_set === 'all' && !(await internalSetAllowed(ctx, d))) {
        throw new PermanentJobError('RESTRICTED_BASIS', 'внутренний набор: у запросившего размещение сейчас нет доступа к основаниям решений в манифесте выпуска; повторить может тот, у кого доступ есть');
      }
      // 2. Пути (A38).
      const problem = pathProblem(d, version, files);
      if (problem) throw new PermanentJobError('INVALID_PATH', problem);
      // 3–7. Папка выпуска: сверка существующей, стадирование, перенос без замены, признак готовности последним.
      const byPath = new Map(files.map((f) => [f.path, f]));
      await placeFolder(
        targetOf(ctx, d.kind, version),
        {
          own: d.id,
          targetFolder: d.target_folder,
          files: files.filter((f) => f.kind !== 'marker').map((f) => ({ path: f.path, sha256: f.sha256, size: Number(f.size_bytes), open: () => ctx.store.openRead(f.sha256) })),
          marker: { name: PLACEMENT_MARKER, bytes: placementBytes(d.placement), sha256: d.placement_sha256 },
        },
        { state: (path, s, sha) => state(byPath.get(path)!, s, sha), step: advance },
      );
      await ctx.complete(async (c) => {
        await setDeliveryStatus(c, id, { status: 'delivered' });
        await insertAttempt(c, { deliveryId: id, jobId: ctx.job.id, startedAt, outcome: 'delivered', errorCode: null, detail: null });
      });
    } catch (err) {
      if (err instanceof PlacementConflict) {
        await ctx.complete(async (c) => {
          await setDeliveryStatus(c, id, { status: 'conflict', errorCode: 'CONFLICT', detail: err.message });
          await insertAttempt(c, { deliveryId: id, jobId: ctx.job.id, startedAt, outcome: 'conflict', errorCode: 'CONFLICT', detail: err.message });
        });
        return;
      }
      if (err instanceof DeliveryAdapterError) {
        // Последняя попытка: попытку запишет терминальная фиксация («ошибка»), без промежуточной записи.
        const last = ctx.job.attempts >= ctx.job.max_attempts;
        if (err.code === 'CONFLICT') {
          await ctx.complete(async (c) => {
            await setDeliveryStatus(c, id, { status: 'conflict', errorCode: 'CONFLICT', detail: err.message });
            await insertAttempt(c, { deliveryId: id, jobId: ctx.job.id, startedAt, outcome: 'conflict', errorCode: 'CONFLICT', detail: err.message });
          });
          return;
        }
        if (err.code === 'TIMEOUT_UNKNOWN_OUTCOME') {
          // Неизвестный исход: следующий запуск только сверяет (A29).
          await ctx.withLease(async (c) => {
            await setDeliveryStatus(c, id, { status: 'outcome_unknown', errorCode: 'OUTCOME_UNKNOWN', detail: err.message });
            if (!last) await insertAttempt(c, { deliveryId: id, jobId: ctx.job.id, startedAt, outcome: 'outcome_unknown', errorCode: 'OUTCOME_UNKNOWN', detail: err.message });
          });
          throw new RetryableJobError('OUTCOME_UNKNOWN', err.message);
        }
        if (err.retryable) {
          await ctx.withLease(async (c) => {
            await setDeliveryStatus(c, id, { status: (await getDelivery(c, id))!.status, errorCode: 'NETWORK', detail: err.message });
            if (!last) await insertAttempt(c, { deliveryId: id, jobId: ctx.job.id, startedAt, outcome: 'interrupted', errorCode: 'NETWORK', detail: err.message });
          });
          throw new RetryableJobError('NETWORK', err.message);
        }
        throw new PermanentJobError(err.code, err.message);
      }
      throw err;
    }
  },
  // Попытки исчерпаны или ошибка неповторяемая: доставка «ошибка» с кодом; другие назначения не затрагиваются (A28).
  onTerminalFailure: async (client, ctx, failure) => {
    const id = String(ctx.job.payload.deliveryId);
    const d = await getDelivery(client, id);
    if (!d || !WORKING.has(d.status)) return;
    // Внутренняя ошибка — без её текста (в нём могут быть полные пути): подробности — в журнале задания.
    const detail = failure.code === 'internal' ? 'внутренняя ошибка размещения; подробности — в журнале заданий' : failure.message;
    await setDeliveryStatus(client, id, { status: 'failed', errorCode: failure.code.slice(0, 60), detail });
    await insertAttempt(client, { deliveryId: id, jobId: ctx.job.id, startedAt: new Date(), outcome: 'failed', errorCode: failure.code.slice(0, 60), detail });
  },
};

// Проверка доступа назначения под учётной записью worker (D-034): результат — запись проверки, задание завершается.
export const deliveryProbeHandler: IJobHandlerSpec = {
  run: async (ctx) => {
    const p = ctx.job.payload as { destinationId: string; versionId: string; requestedBy: string };
    const v = (await getDestinationVersion(ctx.pool, p.versionId))!;
    const kind = (await ctx.pool.query<{ kind: IDeliveryRow['kind'] }>('SELECT kind FROM delivery_destination WHERE id = $1', [p.destinationId])).rows[0]!.kind;
    let outcome: { ok: true } | { ok: false; code: string; detail: string };
    const problem = rootPathProblem(v.root_path) ?? rootPathProblem(v.staging_path) ??
      (kind === 'yandex_disk' && (isPathInside(v.staging_path, v.root_path) || isPathInside(v.root_path, v.staging_path)) ? 'служебная папка Яндекс Диска должна быть вне папки синхронизации' : null);
    if (problem) outcome = { ok: false, code: 'INVALID_PATH', detail: problem };
    else {
      try {
        await targetOf(ctx, kind, v).probe();
        outcome = { ok: true };
      } catch (err) {
        const e = err instanceof DeliveryAdapterError ? err : new DeliveryAdapterError('UNAVAILABLE', 'проверка назначения не удалась');
        outcome = { ok: false, code: e.code, detail: e.message };
      }
    }
    await ctx.complete(async (c) => {
      await insertProbe(c, {
        destinationId: p.destinationId,
        versionId: p.versionId,
        jobId: ctx.job.id,
        requestedBy: p.requestedBy,
        outcome: outcome.ok ? 'ok' : 'failed',
        errorCode: outcome.ok ? null : outcome.code,
        detail: outcome.ok ? null : outcome.detail,
      });
    });
  },
};
