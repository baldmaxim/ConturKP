// Каналы поступления (data-model §4.2 intake_channel) и состояние файлов наблюдаемой папки.
import type { Queryable } from './pool.ts';

export interface IChannelRow {
  id: string;
  tender_id: string;
  kind: 'watched_folder' | 'mail_sync' | 'negotiation_sync';
  origin: 'local' | 'yandex_disk' | 'smb';
  locator: string;
  active: boolean;
  freshness_seconds: number;
  scan_interval_seconds: number;
  last_scan_started_at: Date | null;
  last_successful_scan_at: Date | null;
  last_error_code: string | null;
  last_error_at: Date | null;
  pending_unstable: number;
  disabled_reason: string | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}

const SELECT_CHANNEL = `
  SELECT id, tender_id, kind, origin, locator, active, extract(epoch FROM freshness_window)::int AS freshness_seconds,
         scan_interval_seconds, last_scan_started_at, last_successful_scan_at, last_error_code, last_error_at,
         pending_unstable, disabled_reason, row_version, created_at, updated_at
    FROM intake_channel`;

export const listChannels = async (db: Queryable, tenderId: string): Promise<IChannelRow[]> => {
  const r = await db.query<IChannelRow>(`${SELECT_CHANNEL} WHERE tender_id = $1 ORDER BY created_at`, [tenderId]);
  return r.rows;
};

export const getChannel = async (db: Queryable, id: string, lock = false): Promise<IChannelRow | null> => {
  if (lock) await db.query('SELECT 1 FROM intake_channel WHERE id = $1 FOR UPDATE', [id]);
  const r = await db.query<IChannelRow>(`${SELECT_CHANNEL} WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
};

export const insertChannel = async (
  db: Queryable,
  c: { tenderId: string; origin: IChannelRow['origin']; locator: string; freshnessSeconds: number; scanIntervalSeconds: number; createdBy: string },
): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO intake_channel (tender_id, kind, origin, locator, freshness_window, scan_interval_seconds, created_by)
     VALUES ($1, 'watched_folder', $2, $3, make_interval(secs => $4), $5, $6) RETURNING id`,
    [c.tenderId, c.origin, c.locator, c.freshnessSeconds, c.scanIntervalSeconds, c.createdBy],
  );
  return r.rows[0]!.id;
};

export const updateChannel = async (
  db: Queryable,
  id: string,
  p: {
    origin?: IChannelRow['origin'] | undefined;
    locator?: string | undefined;
    freshnessSeconds?: number | undefined;
    scanIntervalSeconds?: number | undefined;
    active?: boolean | undefined;
    disabledReason?: string | null | undefined;
  },
): Promise<void> => {
  await db.query(
    `UPDATE intake_channel SET
        origin = coalesce($2, origin),
        locator = coalesce($3, locator),
        freshness_window = CASE WHEN $4::int IS NULL THEN freshness_window ELSE make_interval(secs => $4) END,
        scan_interval_seconds = coalesce($5, scan_interval_seconds),
        active = coalesce($6, active),
        disabled_reason = CASE WHEN coalesce($6, active) THEN NULL ELSE coalesce($7, disabled_reason) END,
        updated_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [id, p.origin ?? null, p.locator ?? null, p.freshnessSeconds ?? null, p.scanIntervalSeconds ?? null, p.active ?? null, p.disabledReason ?? null],
  );
};

// Каналы, которым пора сканировать: активные, наблюдаемые папки.
export const dueChannels = async (db: Queryable): Promise<{ id: string; tender_id: string }[]> => {
  const r = await db.query<{ id: string; tender_id: string }>(
    `SELECT id, tender_id FROM intake_channel
      WHERE active AND kind = 'watched_folder'
        AND (last_scan_started_at IS NULL OR last_scan_started_at < now() - make_interval(secs => scan_interval_seconds))`,
  );
  return r.rows;
};

export const markScanStarted = async (db: Queryable, id: string): Promise<void> => {
  await db.query('UPDATE intake_channel SET last_scan_started_at = now() WHERE id = $1', [id]);
};

// Успешный скан — полный проход без файлов, ожидающих стабильности; время — начало скана.
export const markScanResult = async (
  db: Queryable,
  id: string,
  r: { startedAt: Date; pendingUnstable: number; errorCode: string | null },
): Promise<void> => {
  if (r.errorCode) {
    await db.query('UPDATE intake_channel SET last_error_code = $2, last_error_at = now() WHERE id = $1', [id, r.errorCode]);
    return;
  }
  await db.query(
    `UPDATE intake_channel SET pending_unstable = $3, last_error_code = NULL,
            last_successful_scan_at = CASE WHEN $3 = 0 THEN $2 ELSE last_successful_scan_at END
      WHERE id = $1`,
    [id, r.startedAt, r.pendingUnstable],
  );
};

export interface IFileStateRow {
  rel_path: string;
  size_bytes: number;
  mtime_ms: number;
  first_seen_at: Date;
  unchanged_since: Date;
  imported_size: number | null;
  imported_mtime: number | null;
  imported_sha256: string | null;
  missing_since: Date | null;
}

export const loadFileStates = async (db: Queryable, channelId: string): Promise<Map<string, IFileStateRow>> => {
  const r = await db.query<IFileStateRow>('SELECT * FROM intake_file_state WHERE channel_id = $1', [channelId]);
  return new Map(r.rows.map((row) => [row.rel_path, row]));
};

// Наблюдение файла: при изменении размера или времени изменения отсчёт стабильности начинается заново.
export const observeFile = async (db: Queryable, channelId: string, relPath: string, size: number, mtimeMs: number): Promise<void> => {
  await db.query(
    `INSERT INTO intake_file_state (channel_id, rel_path, size_bytes, mtime_ms, first_seen_at, unchanged_since)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (channel_id, rel_path) DO UPDATE SET
       unchanged_since = CASE WHEN intake_file_state.size_bytes = EXCLUDED.size_bytes AND intake_file_state.mtime_ms = EXCLUDED.mtime_ms
                              AND intake_file_state.missing_since IS NULL
                              THEN intake_file_state.unchanged_since ELSE now() END,
       size_bytes = EXCLUDED.size_bytes, mtime_ms = EXCLUDED.mtime_ms, missing_since = NULL`,
    [channelId, relPath, size, mtimeMs],
  );
};

export const markImported = async (db: Queryable, channelId: string, relPath: string, size: number, mtimeMs: number, sha256: string | null): Promise<void> => {
  await db.query(
    'UPDATE intake_file_state SET imported_size = $3, imported_mtime = $4, imported_sha256 = $5 WHERE channel_id = $1 AND rel_path = $2',
    [channelId, relPath, size, mtimeMs, sha256],
  );
};

// Удаление из папки ничего не удаляет в портале (I15): отмечается только отсутствие.
export const markMissing = async (db: Queryable, channelId: string, present: string[]): Promise<void> => {
  await db.query(
    `UPDATE intake_file_state SET missing_since = coalesce(missing_since, now())
      WHERE channel_id = $1 AND NOT (rel_path = ANY($2::text[]))`,
    [channelId, present],
  );
};
