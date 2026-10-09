// Размещение выпуска (этап 14; D-034; проект §2–§8): назначения и их версии путей и политики, проверки доступа, доставки
// с закреплённой версией назначения, набором файлов и признаком готовности, состояния файлов, попытки и решения человека.
// Команды вызываются под блокировкой этапа (порядок «этап → выпуск → доставка»); вторая линия — миграция 0038.
import {
  deliveryFilePlan,
  placementBytes,
  placementManifestOf,
  placementSha256,
  PLACEMENT_MARKER,
  releaseFolderPath,
  type DeliveryFileSet,
  type IPlacementManifest,
} from '@kontur/core';
import { enqueueJob } from './jobs.ts';
import type { Queryable } from './pool.ts';
import { candidateFiles } from './releaseCandidates.ts';

export type DeliveryKind = 'yandex_disk' | 'smb';
export type DeliveryEnvironment = 'test' | 'production';
export type DeliveryStatus = 'pending' | 'staging' | 'committing' | 'verifying' | 'delivered' | 'failed' | 'outcome_unknown' | 'conflict' | 'superseded';
export type CloudState = 'not_applicable' | 'unconfirmed' | 'confirmed';
export type RemoteState = 'absent' | 'staged' | 'committed' | 'verified' | 'conflict' | 'unknown';

export interface IDestinationVersionRow {
  id: string;
  destination_id: string;
  version: number;
  root_path: string;
  staging_path: string;
  include_internal: boolean;
  reason: string;
  created_by: string;
  created_by_name: string;
  created_at: Date;
}

export interface IDestinationRow {
  id: string;
  title: string;
  kind: DeliveryKind;
  environment: DeliveryEnvironment;
  active: boolean;
  current_version_id: string;
  created_at: Date;
  updated_at: Date;
  row_version: number;
}

export interface IProbeRow {
  id: string;
  destination_id: string;
  destination_version_id: string;
  version: number;
  outcome: 'ok' | 'failed';
  error_code: string | null;
  detail: string | null;
  requested_by_name: string;
  checked_at: Date;
}

export interface IDeliveryRow {
  id: string;
  release_id: string;
  tender_id: string;
  stage_id: string;
  destination_id: string;
  destination_title: string;
  destination_version_id: string;
  destination_version: number;
  kind: DeliveryKind;
  environment: DeliveryEnvironment;
  target_folder: string;
  file_set: DeliveryFileSet;
  placement: IPlacementManifest;
  placement_sha256: string;
  status: DeliveryStatus;
  attempt_count: number;
  last_error_code: string | null;
  last_error_detail: string | null;
  superseded_by_delivery_id: string | null;
  delivered_at: Date | null;
  cloud_state: CloudState;
  cloud_confirmed_by: string | null;
  cloud_confirmed_by_name: string | null;
  cloud_confirmed_at: Date | null;
  cloud_note: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  row_version: number;
}

export interface IDeliveryFileStateRow {
  delivery_id: string;
  ordinal: number;
  path: string;
  kind: 'file' | 'manifest' | 'marker';
  sha256: string;
  size_bytes: number;
  remote_state: RemoteState;
  remote_sha256: string | null;
  checked_at: Date | null;
}

export interface IDeliveryAttemptRow {
  delivery_id: string;
  seq: number;
  job_id: string | null;
  started_at: Date;
  finished_at: Date;
  outcome: 'delivered' | 'failed' | 'outcome_unknown' | 'conflict' | 'interrupted';
  error_code: string | null;
  detail: string | null;
}

export interface IDeliveryEventRow {
  id: string;
  delivery_id: string;
  action: 'created' | 'place' | 'retry' | 'resolve_conflict' | 'redirect' | 'confirm_cloud';
  actor_user_id: string | null;
  actor_name: string | null;
  reason: string | null;
  created_at: Date;
}

const num = <T extends object>(r: T, keys: (keyof T)[]): T => {
  const out = { ...r } as Record<keyof T, unknown>;
  for (const k of keys) if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
  return out as T;
};

// ---------------------------------------------------------------- Назначения

export const listDestinations = async (db: Queryable): Promise<IDestinationRow[]> =>
  (await db.query<IDestinationRow>('SELECT * FROM delivery_destination ORDER BY environment, kind, title, id')).rows.map((r) => num(r, ['row_version']));

export const getDestination = async (db: Queryable, id: string, lock = false): Promise<IDestinationRow | null> => {
  const r = (await db.query<IDestinationRow>(`SELECT * FROM delivery_destination WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  return r ? num(r, ['row_version']) : null;
};

const VERSION_SELECT = `SELECT v.*, u.display_name AS created_by_name FROM delivery_destination_version v JOIN app_user u ON u.id = v.created_by`;

export const getDestinationVersion = async (db: Queryable, id: string): Promise<IDestinationVersionRow | null> => {
  const r = (await db.query<IDestinationVersionRow>(`${VERSION_SELECT} WHERE v.id = $1`, [id])).rows[0];
  return r ? num(r, ['version']) : null;
};

export const listDestinationVersions = async (db: Queryable, destinationId: string): Promise<IDestinationVersionRow[]> =>
  (await db.query<IDestinationVersionRow>(`${VERSION_SELECT} WHERE v.destination_id = $1 ORDER BY v.version DESC`, [destinationId])).rows.map((r) => num(r, ['version']));

export const createDestination = async (
  db: Queryable,
  d: { title: string; kind: DeliveryKind; environment: DeliveryEnvironment; rootPath: string; stagingPath: string; includeInternal: boolean; reason: string; userId: string },
): Promise<string> => {
  const id = (
    await db.query<{ id: string }>(
      'INSERT INTO delivery_destination (title, kind, environment, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id',
      [d.title, d.kind, d.environment, d.userId],
    )
  ).rows[0]!.id;
  await addDestinationVersion(db, id, d);
  return id;
};

// Новая версия путей и политики и перевод указателя (D-034: существующие доставки её не видят).
export const addDestinationVersion = async (
  db: Queryable,
  destinationId: string,
  v: { rootPath: string; stagingPath: string; includeInternal: boolean; reason: string; userId: string },
): Promise<string> => {
  const versionId = (
    await db.query<{ id: string }>(
      `INSERT INTO delivery_destination_version (destination_id, version, root_path, staging_path, include_internal, reason, created_by)
       VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM delivery_destination_version WHERE destination_id = $1), $2, $3, $4, $5, $6) RETURNING id`,
      [destinationId, v.rootPath, v.stagingPath, v.includeInternal, v.reason, v.userId],
    )
  ).rows[0]!.id;
  await db.query(
    'UPDATE delivery_destination SET current_version_id = $2, updated_by = $3, updated_at = now(), row_version = row_version + 1 WHERE id = $1',
    [destinationId, versionId, v.userId],
  );
  return versionId;
};

export const updateDestination = async (db: Queryable, id: string, p: { title?: string | undefined; active?: boolean | undefined; userId: string }): Promise<void> => {
  await db.query(
    `UPDATE delivery_destination SET title = coalesce($2, title), active = coalesce($3, active), updated_by = $4, updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [id, p.title ?? null, p.active ?? null, p.userId],
  );
};

export const insertProbe = async (
  db: Queryable,
  p: { destinationId: string; versionId: string; jobId: string | null; requestedBy: string; outcome: 'ok' | 'failed'; errorCode: string | null; detail: string | null },
): Promise<void> => {
  await db.query(
    `INSERT INTO delivery_destination_probe (destination_id, destination_version_id, job_id, requested_by, outcome, error_code, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.destinationId, p.versionId, p.jobId, p.requestedBy, p.outcome, p.errorCode, p.detail?.slice(0, 1000) ?? null],
  );
};

export const lastProbes = async (db: Queryable, destinationIds: readonly string[]): Promise<Map<string, IProbeRow>> => {
  const rows = (
    await db.query<IProbeRow>(
      `SELECT DISTINCT ON (p.destination_id) p.*, v.version, u.display_name AS requested_by_name
         FROM delivery_destination_probe p JOIN delivery_destination_version v ON v.id = p.destination_version_id
         JOIN app_user u ON u.id = p.requested_by
        WHERE p.destination_id = ANY($1::uuid[]) ORDER BY p.destination_id, p.checked_at DESC, p.id`,
      [[...destinationIds]],
    )
  ).rows;
  return new Map(rows.map((r) => [r.destination_id, num(r, ['version'])]));
};

export const enqueueProbe = async (db: Queryable, p: { destinationId: string; versionId: string; requestedBy: string }): Promise<string> =>
  (
    await enqueueJob(db, {
      kind: 'delivery.probe',
      dedupeKey: `delivery-probe:${p.versionId}`,
      payload: p,
      resourceClass: 'network',
      maxAttempts: 1,
    })
  ).id;

// Версии назначений, у которых проверка доступа ещё в очереди или выполняется.
export const pendingProbeVersions = async (db: Queryable, versionIds: readonly string[]): Promise<Set<string>> =>
  new Set(
    (
      await db.query<{ version_id: string }>(
        "SELECT substr(dedupe_key, 16) AS version_id FROM job WHERE kind = 'delivery.probe' AND status IN ('queued', 'running') AND dedupe_key = ANY($1::text[])",
        [versionIds.map((v) => `delivery-probe:${v}`)],
      )
    ).rows.map((r) => r.version_id),
  );

// ---------------------------------------------------------------- Доставки

// Активные назначения среды выпуска без действующей доставки (для «Разместить»).
export const missingDestinationCount = async (db: Queryable, releaseId: string, mode: DeliveryEnvironment): Promise<number> =>
  Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM delivery_destination t
          WHERE t.active AND t.environment = $2
            AND NOT EXISTS (SELECT 1 FROM delivery d WHERE d.release_id = $1 AND d.destination_id = t.id AND d.status <> 'superseded')`,
        [releaseId, mode],
      )
    ).rows[0]!.n,
  );

const DELIVERY_SELECT = `SELECT d.*, t.title AS destination_title, v.version AS destination_version, cu.display_name AS cloud_confirmed_by_name
  FROM delivery d JOIN delivery_destination t ON t.id = d.destination_id JOIN delivery_destination_version v ON v.id = d.destination_version_id
  LEFT JOIN app_user cu ON cu.id = d.cloud_confirmed_by`;

const deliveryOf = (r: IDeliveryRow): IDeliveryRow => num(r, ['attempt_count', 'row_version', 'destination_version']);

export const getDelivery = async (db: Queryable, id: string, lock = false): Promise<IDeliveryRow | null> => {
  const r = (await db.query<IDeliveryRow>(`${DELIVERY_SELECT} WHERE d.id = $1${lock ? ' FOR UPDATE OF d' : ''}`, [id])).rows[0];
  return r ? deliveryOf(r) : null;
};

export const listDeliveries = async (db: Queryable, releaseId: string): Promise<IDeliveryRow[]> =>
  (await db.query<IDeliveryRow>(`${DELIVERY_SELECT} WHERE d.release_id = $1 ORDER BY d.created_at, t.title, d.id`, [releaseId])).rows.map(deliveryOf);

export const fileStates = async (db: Queryable, deliveryId: string): Promise<IDeliveryFileStateRow[]> =>
  (await db.query<IDeliveryFileStateRow>('SELECT * FROM delivery_file_state WHERE delivery_id = $1 ORDER BY ordinal', [deliveryId])).rows.map((r) => num(r, ['ordinal', 'size_bytes']));

export const deliveryAttempts = async (db: Queryable, deliveryId: string): Promise<IDeliveryAttemptRow[]> =>
  (await db.query<IDeliveryAttemptRow>('SELECT * FROM delivery_attempt WHERE delivery_id = $1 ORDER BY seq', [deliveryId])).rows.map((r) => num(r, ['seq']));

export const deliveryEvents = async (db: Queryable, deliveryId: string): Promise<IDeliveryEventRow[]> =>
  (
    await db.query<IDeliveryEventRow>(
      'SELECT e.id, e.delivery_id, e.action, e.actor_user_id, u.display_name AS actor_name, e.reason, e.created_at FROM delivery_event e LEFT JOIN app_user u ON u.id = e.actor_user_id WHERE e.delivery_id = $1 ORDER BY e.created_at, e.id',
      [deliveryId],
    )
  ).rows;

interface IReleaseForDelivery {
  id: string;
  tender_id: string;
  stage_id: string;
  mode: DeliveryEnvironment;
  content_hash: string;
  candidate_id: string;
  release_manifest_blob_sha256: string;
  release_manifest_sha256: string;
  release_manifest_size: number;
  candidate_manifest_sha256: string;
  candidate_manifest_size: number;
  candidate_seq: number;
  stage_seq: number;
  tender_code: string;
}

const releaseForDelivery = async (db: Queryable, releaseId: string): Promise<IReleaseForDelivery> =>
  num(
    (
      await db.query<IReleaseForDelivery>(
        `SELECT r.id, r.tender_id, r.stage_id, r.mode, r.content_hash, r.candidate_id, r.release_manifest_blob_sha256, r.release_manifest_sha256,
                rb.size_bytes AS release_manifest_size, c.manifest_blob_sha256 AS candidate_manifest_sha256, cb.size_bytes AS candidate_manifest_size,
                c.seq AS candidate_seq, s.seq AS stage_seq, t.code AS tender_code
           FROM release r JOIN release_candidate c ON c.id = r.candidate_id JOIN blob rb ON rb.sha256 = r.release_manifest_blob_sha256
           JOIN blob cb ON cb.sha256 = c.manifest_blob_sha256 JOIN tender_stage s ON s.id = r.stage_id JOIN tender t ON t.id = r.tender_id
          WHERE r.id = $1`,
        [releaseId],
      )
    ).rows[0]!,
    ['release_manifest_size', 'candidate_manifest_size', 'candidate_seq', 'stage_seq'],
  );

// Активные назначения среды выпуска без действующей доставки этого выпуска.
const missingDestinations = async (db: Queryable, release: IReleaseForDelivery): Promise<(IDestinationRow & { include_internal: boolean })[]> =>
  (
    await db.query<IDestinationRow & { include_internal: boolean }>(
      `SELECT t.*, v.include_internal FROM delivery_destination t JOIN delivery_destination_version v ON v.id = t.current_version_id
        WHERE t.active AND t.environment = $2
          AND NOT EXISTS (SELECT 1 FROM delivery d WHERE d.release_id = $1 AND d.destination_id = t.id AND d.status <> 'superseded')
        ORDER BY t.kind, t.title, t.id`,
      [release.id, release.mode],
    )
  ).rows;

// Доставка с закреплёнными версией назначения, папкой выпуска, набором файлов и признаком; задание размещения.
const insertDelivery = async (
  db: Queryable,
  release: IReleaseForDelivery,
  dest: IDestinationRow & { include_internal: boolean },
  createdBy: string | null,
  reason: string | null,
): Promise<string> => {
  const set: DeliveryFileSet = dest.include_internal ? 'all' : 'customer';
  const files = await candidateFiles(db, release.candidate_id);
  const plan = deliveryFilePlan(
    set,
    files.sort((a, b) => a.ordinal - b.ordinal).map((f) => ({ path: f.path, role: f.role, audience: f.audience, sha256: f.blob_sha256, size: Number(f.size_bytes) })),
    {
      candidate: { sha256: release.candidate_manifest_sha256, size: release.candidate_manifest_size },
      release: { sha256: release.release_manifest_blob_sha256, size: release.release_manifest_size },
    },
  );
  const placement = placementManifestOf(
    { id: release.id, mode: release.mode, contentHash: release.content_hash, releaseManifestSha256: release.release_manifest_sha256 },
    set,
    plan,
  );
  const target = releaseFolderPath({ tenderCode: release.tender_code, stageSeq: release.stage_seq, candidateSeq: release.candidate_seq, releaseId: release.id });
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO delivery (release_id, tender_id, stage_id, destination_id, destination_version_id, kind, environment, target_folder, file_set,
                             placement, placement_sha256, cloud_state, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        release.id, release.tender_id, release.stage_id, dest.id, dest.current_version_id, dest.kind, dest.environment, target, set,
        JSON.stringify(placement), placementSha256(placement), dest.kind === 'smb' ? 'not_applicable' : 'unconfirmed', createdBy,
      ],
    )
  ).rows[0]!.id;
  const markerSize = placementBytes(placement).length;
  const rows = [
    ...plan.map((f) => ({ path: f.path, kind: f.kind, sha256: f.sha256, size: f.size })),
    { path: PLACEMENT_MARKER, kind: 'marker' as const, sha256: placementSha256(placement), size: markerSize },
  ];
  await db.query(
    `INSERT INTO delivery_file_state (delivery_id, ordinal, path, kind, sha256, size_bytes)
     SELECT $1, n, p, k, s, z FROM unnest($2::text[], $3::text[], $4::text[], $5::bigint[]) WITH ORDINALITY AS x(p, k, s, z, n)`,
    [id, rows.map((r) => r.path), rows.map((r) => r.kind), rows.map((r) => r.sha256), rows.map((r) => r.size)],
  );
  await insertDeliveryEvent(db, { deliveryId: id, action: createdBy ? 'place' : 'created', actorUserId: createdBy, reason });
  await enqueueDelivery(db, id, release.tender_id);
  return id;
};

// Доставки выпуска во все активные назначения его среды, которых ещё нет (в транзакции выпуска или «Разместить»).
export const createDeliveriesForRelease = async (db: Queryable, releaseId: string, createdBy: string | null, reason: string | null = null): Promise<string[]> => {
  const release = await releaseForDelivery(db, releaseId);
  const out: string[] = [];
  for (const dest of await missingDestinations(db, release)) out.push(await insertDelivery(db, release, dest, createdBy, reason));
  return out;
};

export const enqueueDelivery = async (db: Queryable, deliveryId: string, tenderId: string): Promise<void> => {
  await enqueueJob(db, { kind: 'delivery.place', dedupeKey: `delivery:${deliveryId}`, payload: { deliveryId }, resourceClass: 'network', maxAttempts: 5, tenderId });
};

export const insertDeliveryEvent = async (
  db: Queryable,
  e: { deliveryId: string; action: IDeliveryEventRow['action']; actorUserId: string | null; reason: string | null },
): Promise<void> => {
  await db.query('INSERT INTO delivery_event (delivery_id, action, actor_user_id, reason) VALUES ($1, $2, $3, $4)', [e.deliveryId, e.action, e.actorUserId, e.reason]);
};

// ---------------------------------------------------------------- Запись worker (под арендой задания)

export const setDeliveryStatus = async (
  db: Queryable,
  id: string,
  s: { status: DeliveryStatus; errorCode?: string | null; detail?: string | null; attempt?: boolean },
): Promise<void> => {
  await db.query(
    `UPDATE delivery SET status = $2, last_error_code = $3, last_error_detail = $4, attempt_count = attempt_count + $5,
            delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END, updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [id, s.status, s.errorCode ?? null, s.detail?.slice(0, 1000) ?? null, s.attempt ? 1 : 0],
  );
};

export const setFileState = async (db: Queryable, deliveryId: string, ordinal: number, state: RemoteState, remoteSha256: string | null): Promise<void> => {
  await db.query('UPDATE delivery_file_state SET remote_state = $3, remote_sha256 = $4, checked_at = now() WHERE delivery_id = $1 AND ordinal = $2', [
    deliveryId,
    ordinal,
    state,
    remoteSha256,
  ]);
};

export const insertAttempt = async (
  db: Queryable,
  a: { deliveryId: string; jobId: string | null; startedAt: Date; outcome: IDeliveryAttemptRow['outcome']; errorCode: string | null; detail: string | null },
): Promise<void> => {
  await db.query(
    `INSERT INTO delivery_attempt (delivery_id, seq, job_id, started_at, outcome, error_code, detail)
     VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM delivery_attempt WHERE delivery_id = $1), $2, $3, $4, $5, $6)`,
    [a.deliveryId, a.jobId, a.startedAt, a.outcome, a.errorCode, a.detail?.slice(0, 1000) ?? null],
  );
};

// ---------------------------------------------------------------- Решения человека (вызывающий держит блокировку этапа)

export const retryDelivery = async (db: Queryable, d: IDeliveryRow, action: 'retry' | 'resolve_conflict', userId: string, reason: string): Promise<void> => {
  await insertDeliveryEvent(db, { deliveryId: d.id, action, actorUserId: userId, reason });
  await db.query("UPDATE delivery SET status = 'pending', updated_at = now(), row_version = row_version + 1 WHERE id = $1", [d.id]);
  await enqueueDelivery(db, d.id, d.tender_id);
};

// Перенаправление: прежняя доставка заменяется новой на текущую версию того же назначения.
export const redirectDelivery = async (db: Queryable, d: IDeliveryRow, userId: string, reason: string): Promise<string> => {
  await insertDeliveryEvent(db, { deliveryId: d.id, action: 'redirect', actorUserId: userId, reason });
  await db.query("UPDATE delivery SET status = 'superseded', updated_at = now(), row_version = row_version + 1 WHERE id = $1", [d.id]);
  const release = await releaseForDelivery(db, d.release_id);
  const dest = (
    await db.query<IDestinationRow & { include_internal: boolean }>(
      'SELECT t.*, v.include_internal FROM delivery_destination t JOIN delivery_destination_version v ON v.id = t.current_version_id WHERE t.id = $1',
      [d.destination_id],
    )
  ).rows[0]!;
  const next = await insertDelivery(db, release, dest, userId, reason);
  await db.query('UPDATE delivery SET superseded_by_delivery_id = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1', [d.id, next]);
  return next;
};

export const confirmCloud = async (db: Queryable, d: IDeliveryRow, userId: string, note: string): Promise<void> => {
  await insertDeliveryEvent(db, { deliveryId: d.id, action: 'confirm_cloud', actorUserId: userId, reason: note });
  await db.query(
    "UPDATE delivery SET cloud_state = 'confirmed', cloud_confirmed_by = $2, cloud_confirmed_at = now(), cloud_note = $3, updated_at = now(), row_version = row_version + 1 WHERE id = $1",
    [d.id, userId, note],
  );
};
