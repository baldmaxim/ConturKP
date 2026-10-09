// Размещение выпуска (этап 14; D-034; portal-api §2.10; state-machines §16). Назначения — только администратор (В-14-5):
// пути и политика внутренних материалов — новой версией, проверка доступа — задание worker под учётной записью службы.
// Доставки — у каждого назначения своя (A28): «Разместить», «Повторить», «Повторить после проверки», «Перенаправить»,
// «Подтвердить облако» — delivery.manage, только человек, с причиной; команда — одна транзакция под блокировкой этапа.
// Полные пути видит только администратор; остальным — папка выпуска относительно корня (проект §9).
import {
  ConfirmCloudRequest,
  CreateDestinationRequest,
  DeliveryReasonRequest,
  NewDestinationVersionRequest,
  PatchDestinationRequest,
  PlaceDeliveriesRequest,
} from '@kontur/contracts';
import { formatEtag, globalCapabilities, isPathInside, rootPathProblem } from '@kontur/core';
import {
  addDestinationVersion,
  confirmCloud,
  createDeliveriesForRelease,
  createDestination,
  deliveryAttempts,
  deliveryEvents,
  enqueueProbe,
  fileStates,
  getDelivery,
  getDestination,
  getDestinationVersion,
  getRelease,
  lastProbes,
  listDeliveries,
  listDestinations,
  listDestinationVersions,
  lockTenderStages,
  missingDestinationCount,
  pendingProbeVersions,
  redirectDelivery,
  retryDelivery,
  updateDestination,
  type DeliveryKind,
  type IAccessContext,
  type IDeliveryRow,
  type IDestinationRow,
  type IDestinationVersionRow,
  type IProbeRow,
  type Pool,
  type PoolClient,
  type Queryable,
} from '@kontur/db';
import { Router, type Request } from 'express';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { iso, loadVisibleRelease } from '../releaseViews.ts';
import { conflict } from './reviewScope.ts';
import { hasTenderCap } from './scope.ts';

const isAdmin = (ctx: IAccessContext): boolean => globalCapabilities(ctx.roles).includes('admin.delivery');

const STAGING_DEFAULT = '.kontur-staging';

// ---------------------------------------------------------------- Пути назначения (проект §6)

const trimRoot = (p: string): string => (p.length > 3 ? p.replace(/[\\/]+$/u, '') : p);

const pathsOf = (kind: DeliveryKind, rootRaw: string, stagingRaw: string | null | undefined): { root: string; staging: string } => {
  const bad = (message: string) => new HttpError(400, 'VALIDATION_FAILED', message);
  const root = trimRoot(rootRaw);
  const rp = rootPathProblem(root);
  if (rp) throw bad(`корень: ${rp}`);
  let staging: string;
  if (stagingRaw === null || stagingRaw === undefined || stagingRaw === '') {
    if (kind === 'yandex_disk') throw bad('служебная папка Яндекс Диска обязательна: вне папки синхронизации, на том же диске');
    const sep = root.startsWith('/') ? '/' : '\\';
    staging = `${root}${/[\\/]$/u.test(root) ? '' : sep}${STAGING_DEFAULT}`;
  } else staging = trimRoot(stagingRaw);
  const sp = rootPathProblem(staging);
  if (sp) throw bad(`служебная папка: ${sp}`);
  if (isPathInside(root, staging)) throw bad('корень не может лежать внутри служебной папки');
  if (kind === 'yandex_disk' && isPathInside(staging, root)) {
    throw bad('служебная папка Яндекс Диска должна быть вне папки синхронизации: иначе клиент начнёт выгружать незавершённые файлы');
  }
  return { root, staging };
};

// ---------------------------------------------------------------- Представления

const versionView = (v: IDestinationVersionRow) => ({
  id: v.id,
  version: v.version,
  rootPath: v.root_path,
  stagingPath: v.staging_path,
  includeInternal: v.include_internal,
  reason: v.reason,
  createdBy: { id: v.created_by, name: v.created_by_name },
  createdAt: iso(v.created_at),
});

const probeView = (p: IProbeRow | undefined, currentVersionId: string) =>
  p
    ? {
        version: p.version,
        current: p.destination_version_id === currentVersionId,
        outcome: p.outcome,
        errorCode: p.error_code,
        detail: p.detail,
        requestedBy: p.requested_by_name,
        checkedAt: iso(p.checked_at),
      }
    : null;

const destinationViews = async (db: Queryable, rows: IDestinationRow[]) => {
  const probes = await lastProbes(db, rows.map((d) => d.id));
  const pending = await pendingProbeVersions(db, rows.map((d) => d.current_version_id));
  const out = [];
  for (const d of rows) {
    const versions = await listDestinationVersions(db, d.id);
    out.push({
      id: d.id,
      title: d.title,
      kind: d.kind,
      environment: d.environment,
      active: d.active,
      rowVersion: d.row_version,
      etag: formatEtag(d.id, d.row_version),
      current: versionView(versions.find((v) => v.id === d.current_version_id)!),
      versions: versions.map(versionView),
      lastProbe: probeView(probes.get(d.id), d.current_version_id),
      probePending: pending.has(d.current_version_id),
      createdAt: iso(d.created_at),
      updatedAt: iso(d.updated_at),
    });
  }
  return out;
};

const destinationResult = async (db: Queryable, id: string, status: number, audit: { action: string; details: Record<string, unknown> }) => {
  const d = (await getDestination(db, id))!;
  return {
    status,
    body: (await destinationViews(db, [d]))[0],
    etag: formatEtag(d.id, d.row_version),
    audit: [{ action: audit.action, entityType: 'delivery_destination', entityId: d.id, details: { kind: d.kind, environment: d.environment, ...audit.details } }],
  };
};

const canManage = (ctx: IAccessContext, d: { tender_id: string }): boolean => hasTenderCap(ctx, d.tender_id, 'delivery.manage');

// Перенаправление возможно, если у назначения есть более новая версия путей и назначение включено.
const redirectTarget = async (db: Queryable, d: IDeliveryRow): Promise<{ ok: boolean; reason: 'version_not_newer' | 'destination_inactive' | null }> => {
  const dest = (await getDestination(db, d.destination_id))!;
  if (!dest.active) return { ok: false, reason: 'destination_inactive' };
  const current = (await getDestinationVersion(db, dest.current_version_id))!;
  return current.version > d.destination_version ? { ok: true, reason: null } : { ok: false, reason: 'version_not_newer' };
};

const deliveryView = async (db: Queryable, ctx: IAccessContext, d: IDeliveryRow) => {
  const manage = canManage(ctx, d);
  const redirect = manage && (d.status === 'failed' || d.status === 'conflict') ? await redirectTarget(db, d) : { ok: false };
  return {
    id: d.id,
    releaseId: d.release_id,
    destination: { id: d.destination_id, title: d.destination_title, kind: d.kind, environment: d.environment, version: d.destination_version },
    targetFolder: d.target_folder,
    fileSet: d.file_set,
    status: d.status,
    attemptCount: d.attempt_count,
    lastError: d.last_error_code ? { code: d.last_error_code, detail: d.last_error_detail } : null,
    supersededBy: d.superseded_by_delivery_id,
    deliveredAt: iso(d.delivered_at),
    // У Яндекс Диска «размещено» = «проверено в локальной папке синхронизации»; облако — отдельно (D-034).
    cloud:
      d.kind === 'yandex_disk'
        ? { state: d.cloud_state, confirmedBy: d.cloud_confirmed_by_name, confirmedAt: iso(d.cloud_confirmed_at), note: d.cloud_note }
        : null,
    files: (await fileStates(db, d.id)).map((f) => ({
      path: f.path,
      kind: f.kind,
      size: f.size_bytes,
      sha256: f.sha256,
      remoteState: f.remote_state,
      checkedAt: iso(f.checked_at),
    })),
    attempts: (await deliveryAttempts(db, d.id)).map((a) => ({
      seq: a.seq,
      startedAt: iso(a.started_at),
      finishedAt: iso(a.finished_at),
      outcome: a.outcome,
      errorCode: a.error_code,
      detail: a.detail,
    })),
    events: (await deliveryEvents(db, d.id)).map((e) => ({ action: e.action, actor: e.actor_name, reason: e.reason, createdAt: iso(e.created_at) })),
    createdAt: iso(d.created_at),
    updatedAt: iso(d.updated_at),
    rowVersion: d.row_version,
    etag: formatEtag(d.id, d.row_version),
    actions: {
      retry: manage && d.status === 'failed',
      resolveConflict: manage && d.status === 'conflict',
      redirect: redirect.ok,
      confirmCloud: manage && d.kind === 'yandex_disk' && d.status === 'delivered' && d.cloud_state === 'unconfirmed',
    },
  };
};

const releaseDeliveries = async (db: Queryable, ctx: IAccessContext, r: { id: string; tender_id: string; mode: 'test' | 'production' }) => {
  const rows = await listDeliveries(db, r.id);
  const items = [];
  for (const d of rows) items.push(await deliveryView(db, ctx, d));
  const active = rows.filter((d) => d.status !== 'superseded');
  const yandex = active.filter((d) => d.kind === 'yandex_disk');
  const missing = await missingDestinationCount(db, r.id, r.mode);
  return {
    items,
    summary: {
      total: active.length,
      delivered: active.filter((d) => d.status === 'delivered').length,
      cloudTotal: yandex.length,
      cloudConfirmed: yandex.filter((d) => d.cloud_state === 'confirmed').length,
      missing,
    },
    canPlace: hasTenderCap(ctx, r.tender_id, 'delivery.manage') && missing > 0,
  };
};

// ---------------------------------------------------------------- Доставка под блокировкой

const loadDelivery = async (db: Queryable, ctx: IAccessContext, id: string): Promise<IDeliveryRow> => {
  const d = await getDelivery(db, id);
  if (!d) throw notFound({ entityType: 'delivery', entityId: id });
  await loadVisibleRelease(db, ctx, await getRelease(db, d.release_id), d.release_id).catch((err: unknown) => {
    if (err instanceof HttpError && err.status === 404) throw notFound({ entityType: 'delivery', entityId: id });
    throw err;
  });
  return d;
};

const authorizeManage = async (client: PoolClient, ctx: IAccessContext, req: Request): Promise<void> => {
  const d = await loadDelivery(client, ctx, uuidParam(req, 'id', 'delivery'));
  if (!canManage(ctx, d)) throw forbidden('delivery.manage', { tenderId: d.tender_id, entityType: 'delivery', entityId: d.id });
};

// Порядок блокировок: этап → доставка.
const lockedDelivery = async (client: PoolClient, ctx: IAccessContext, req: Request): Promise<IDeliveryRow> => {
  const head = await loadDelivery(client, ctx, uuidParam(req, 'id', 'delivery'));
  await lockTenderStages(client, head.tender_id, [head.stage_id]);
  const d = (await getDelivery(client, head.id, true))!;
  if (requireIfMatch(req, d.id) !== d.row_version) throw versionConflict(await deliveryView(client, ctx, d));
  return d;
};

const target = (d: IDeliveryRow) => ({ tenderId: d.tender_id, entityType: 'delivery', entityId: d.id });

const deliveryResult = async (client: Queryable, ctx: IAccessContext, id: string, status: number, audit: { action: string; details: Record<string, unknown> }) => {
  const d = (await getDelivery(client, id))!;
  return {
    status,
    body: await deliveryView(client, ctx, d),
    etag: formatEtag(d.id, d.row_version),
    audit: [
      {
        action: audit.action,
        entityType: 'delivery',
        entityId: d.id,
        tenderId: d.tender_id,
        details: { releaseId: d.release_id, destinationId: d.destination_id, kind: d.kind, environment: d.environment, ...audit.details },
      },
    ],
  };
};

export const deliveriesRouter = (pool: Pool): Router => {
  const router = Router();

  // ---------------------------------------------------------------- Назначения (администратор)

  router.get(
    '/delivery-destinations',
    query(pool, 'delivery.destination.list', 'delivery_destination', async (ctx, _req, res) => {
      if (!isAdmin(ctx)) throw forbidden('admin.delivery', { entityType: 'delivery_destination' });
      res.json({ items: await destinationViews(pool, await listDestinations(pool)) });
    }),
  );

  router.post(
    '/delivery-destinations',
    command(pool, {
      action: 'delivery.destination.create',
      entityType: 'delivery_destination',
      idempotent: true,
      authorize: async (_client, ctx) => {
        if (!isAdmin(ctx)) throw forbidden('admin.delivery', { entityType: 'delivery_destination' });
      },
      run: async (client, ctx, req) => {
        const body = parseBody(CreateDestinationRequest, req.body);
        const paths = pathsOf(body.kind, body.rootPath, body.stagingPath);
        const id = await createDestination(client, {
          title: body.title,
          kind: body.kind,
          environment: body.environment,
          rootPath: paths.root,
          stagingPath: paths.staging,
          includeInternal: body.includeInternal,
          reason: body.reason,
          userId: ctx.principal.userId,
        });
        return destinationResult(client, id, 201, {
          action: 'delivery.destination.create',
          details: { title: body.title, version: 1, rootPath: paths.root, stagingPath: paths.staging, includeInternal: body.includeInternal },
        });
      },
    }),
  );

  // Новая версия путей и политики: существующие доставки остаются на своей версии (R01-05, RT-05).
  router.post(
    '/delivery-destinations/:id/versions',
    command(pool, {
      action: 'delivery.destination.version',
      entityType: 'delivery_destination',
      idempotent: true,
      authorize: async (_client, ctx, req) => {
        if (!isAdmin(ctx)) throw forbidden('admin.delivery', { entityType: 'delivery_destination', entityId: uuidParam(req, 'id', 'delivery_destination') });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'delivery_destination');
        const d = await getDestination(client, id, true);
        if (!d) throw notFound({ entityType: 'delivery_destination', entityId: id });
        if (requireIfMatch(req, d.id) !== d.row_version) throw versionConflict((await destinationViews(client, [d]))[0]);
        const body = parseBody(NewDestinationVersionRequest, req.body);
        const paths = pathsOf(d.kind, body.rootPath, body.stagingPath);
        const before = (await getDestinationVersion(client, d.current_version_id))!;
        const versionId = await addDestinationVersion(client, d.id, {
          rootPath: paths.root,
          stagingPath: paths.staging,
          includeInternal: body.includeInternal,
          reason: body.reason,
          userId: ctx.principal.userId,
        });
        const after = (await getDestinationVersion(client, versionId))!;
        return destinationResult(client, d.id, 201, {
          action: 'delivery.destination.version',
          details: {
            version: { from: before.version, to: after.version },
            rootPath: { from: before.root_path, to: after.root_path },
            stagingPath: { from: before.staging_path, to: after.staging_path },
            includeInternal: { from: before.include_internal, to: after.include_internal },
          },
        });
      },
    }),
  );

  router.patch(
    '/delivery-destinations/:id',
    command(pool, {
      action: 'delivery.destination.update',
      entityType: 'delivery_destination',
      authorize: async (_client, ctx, req) => {
        if (!isAdmin(ctx)) throw forbidden('admin.delivery', { entityType: 'delivery_destination', entityId: uuidParam(req, 'id', 'delivery_destination') });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'delivery_destination');
        const d = await getDestination(client, id, true);
        if (!d) throw notFound({ entityType: 'delivery_destination', entityId: id });
        if (requireIfMatch(req, d.id) !== d.row_version) throw versionConflict((await destinationViews(client, [d]))[0]);
        const body = parseBody(PatchDestinationRequest, req.body);
        await updateDestination(client, d.id, { title: body.title, active: body.active, userId: ctx.principal.userId });
        const after = (await getDestination(client, d.id))!;
        const changes: Record<string, unknown> = {};
        if (after.title !== d.title) changes.title = { from: d.title, to: after.title };
        if (after.active !== d.active) changes.active = { from: d.active, to: after.active };
        return destinationResult(client, d.id, 200, { action: 'delivery.destination.update', details: { changes } });
      },
    }),
  );

  // «Проверить назначение»: проверку выполняет worker под учётной записью службы (D-034), результат — в lastProbe.
  router.post(
    '/delivery-destinations/:id/probe',
    command(pool, {
      action: 'delivery.destination.probe',
      entityType: 'delivery_destination',
      idempotent: true,
      authorize: async (_client, ctx, req) => {
        if (!isAdmin(ctx)) throw forbidden('admin.delivery', { entityType: 'delivery_destination', entityId: uuidParam(req, 'id', 'delivery_destination') });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'delivery_destination');
        const d = await getDestination(client, id, true);
        if (!d) throw notFound({ entityType: 'delivery_destination', entityId: id });
        const jobId = await enqueueProbe(client, { destinationId: d.id, versionId: d.current_version_id, requestedBy: ctx.principal.userId });
        const r = await destinationResult(client, d.id, 202, { action: 'delivery.destination.probe', details: { versionId: d.current_version_id, jobId } });
        return { ...r, body: { ...(r.body as object), jobId } };
      },
    }),
  );

  // ---------------------------------------------------------------- Доставки выпуска

  router.get(
    '/releases/:id/deliveries',
    query(pool, 'delivery.list', 'release', async (ctx, req, res) => {
      const id = uuidParam(req, 'id', 'release');
      const { release } = await loadVisibleRelease(pool, ctx, await getRelease(pool, id), id);
      res.json(await releaseDeliveries(pool, ctx, release));
    }),
  );

  router.get(
    '/deliveries/:id',
    query(pool, 'delivery.read', 'delivery', async (ctx, req, res) => {
      const d = await loadDelivery(pool, ctx, uuidParam(req, 'id', 'delivery'));
      res.setHeader('ETag', formatEtag(d.id, d.row_version));
      res.json(await deliveryView(pool, ctx, d));
    }),
  );

  // «Разместить»: недостающие доставки в активные назначения среды выпуска (идемпотентно; существующие не трогает).
  router.post(
    '/releases/:id/deliveries',
    command(pool, {
      action: 'delivery.place',
      entityType: 'release',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'release');
        const { release } = await loadVisibleRelease(client, ctx, await getRelease(client, id), id);
        if (!hasTenderCap(ctx, release.tender_id, 'delivery.manage')) throw forbidden('delivery.manage', { tenderId: release.tender_id, entityType: 'release', entityId: id });
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'release');
        const { release } = await loadVisibleRelease(client, ctx, await getRelease(client, id), id);
        await lockTenderStages(client, release.tender_id, [release.stage_id]);
        const body = parseBody(PlaceDeliveriesRequest, req.body);
        const created = await createDeliveriesForRelease(client, release.id, ctx.principal.userId, body.reason ?? null);
        return {
          status: created.length > 0 ? 201 : 200,
          body: { created, ...(await releaseDeliveries(client, ctx, release)) },
          audit: [{ action: 'delivery.place', entityType: 'release', entityId: release.id, tenderId: release.tender_id, details: { created, mode: release.mode } }],
        };
      },
    }),
  );

  router.post(
    '/deliveries/:id/retry',
    command(pool, {
      action: 'delivery.retry',
      entityType: 'delivery',
      idempotent: true,
      authorize: authorizeManage,
      run: async (client, ctx, req) => {
        const d = await lockedDelivery(client, ctx, req);
        const body = parseBody(DeliveryReasonRequest, req.body);
        if (d.status !== 'failed') throw conflict('повторить можно доставку с ошибкой', 'not_failed', target(d), { status: d.status });
        await retryDelivery(client, d, 'retry', ctx.principal.userId, body.reason);
        return deliveryResult(client, ctx, d.id, 200, { action: 'delivery.retry', details: { from: d.status, lastError: d.last_error_code } });
      },
    }),
  );

  // После ручной проверки папки выпуска: портал снова сверяет и ничего не перезаписывает (A30).
  router.post(
    '/deliveries/:id/resolve-conflict',
    command(pool, {
      action: 'delivery.resolve_conflict',
      entityType: 'delivery',
      idempotent: true,
      authorize: authorizeManage,
      run: async (client, ctx, req) => {
        const d = await lockedDelivery(client, ctx, req);
        const body = parseBody(DeliveryReasonRequest, req.body);
        if (d.status !== 'conflict') throw conflict('повторить после проверки можно доставку в конфликте', 'not_conflict', target(d), { status: d.status });
        await retryDelivery(client, d, 'resolve_conflict', ctx.principal.userId, body.reason);
        return deliveryResult(client, ctx, d.id, 200, { action: 'delivery.resolve_conflict', details: { from: d.status } });
      },
    }),
  );

  // Перенаправление на новую версию путей того же назначения: прежняя доставка и её попытки сохраняются.
  router.post(
    '/deliveries/:id/redirect',
    command(pool, {
      action: 'delivery.redirect',
      entityType: 'delivery',
      idempotent: true,
      authorize: authorizeManage,
      run: async (client, ctx, req) => {
        const d = await lockedDelivery(client, ctx, req);
        const body = parseBody(DeliveryReasonRequest, req.body);
        if (d.status !== 'failed' && d.status !== 'conflict') throw conflict('перенаправить можно доставку с ошибкой или в конфликте', 'not_failed', target(d), { status: d.status });
        await getDestination(client, d.destination_id, true);
        const t = await redirectTarget(client, d);
        if (!t.ok) {
          throw conflict(
            t.reason === 'destination_inactive' ? 'назначение выключено' : 'у назначения нет более новой версии путей: администратор заводит её в «Назначениях размещения»',
            t.reason!,
            target(d),
          );
        }
        const next = await redirectDelivery(client, d, ctx.principal.userId, body.reason);
        const r = await deliveryResult(client, ctx, next, 201, { action: 'delivery.redirect', details: { supersedes: d.id, from: d.status } });
        return { ...r, audit: [...r.audit, ...(await deliveryResult(client, ctx, d.id, 200, { action: 'delivery.superseded', details: { supersededBy: next } })).audit] };
      },
    }),
  );

  // Облако Яндекс Диска (D-034): портал синхронизацию не наблюдает; подтверждает человек — как проверено.
  router.post(
    '/deliveries/:id/confirm-cloud',
    command(pool, {
      action: 'delivery.confirm_cloud',
      entityType: 'delivery',
      idempotent: true,
      authorize: authorizeManage,
      run: async (client, ctx, req) => {
        const d = await lockedDelivery(client, ctx, req);
        const body = parseBody(ConfirmCloudRequest, req.body);
        if (d.kind !== 'yandex_disk') throw conflict('облако подтверждается только у Яндекс Диска', 'not_yandex', target(d));
        if (d.status !== 'delivered') throw conflict('облако подтверждается после проверки в локальной папке', 'not_delivered', target(d), { status: d.status });
        if (d.cloud_state !== 'unconfirmed') throw conflict('облако уже подтверждено', 'already_confirmed', target(d));
        await confirmCloud(client, d, ctx.principal.userId, body.note);
        return deliveryResult(client, ctx, d.id, 200, { action: 'delivery.confirm_cloud', details: {} });
      },
    }),
  );

  return router;
};
