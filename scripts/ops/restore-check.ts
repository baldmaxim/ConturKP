// npm run ops:restore-check -- [--backup <каталог копии>] [--db kontur_restore_<имя>] [--login <логин> [--password-stdin]]
//                              [--out <журнал>] [--vectors-timeout <с>] [--drop-after]
// Проверка восстановления на чистом окружении (этап 17, ADR-011 §11, docs/runbooks/backup-restore.md). Восстанавливает
// копию в НОВУЮ базу kontur_restore_* (RESTORE_ADMIN_URL — суперпользователь кластера проверки) и ПУСТОЙ каталог
// (RESTORE_STORAGE_ROOT), сверяет схему, хэши и перечень, запускает server и worker на копии (worker — WORKER_MODE=
// restore_check: без размещений, сканов и выгрузок), открывает исторический выпуск, его манифест и цитату от имени
// --login (пароль вводится скрыто), проверяет поиск и достройку векторов. Рабочие база, хранилище и каталог копий
// (DATABASE_URL, STORAGE_ROOT, BACKUP_ROOT) — только для охранников: поверх них восстановление не выполняется.
// Код выхода: 0 — PASS, 1 — FAIL, 2 — неверный запуск, 3 — NOT_RUN (нет pg_restore нужной версии).
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { dropDatabase } from '../../packages/db/src/index.ts';
import { latestCompleteBackup } from '../../packages/storage/src/index.ts';
import { argValue, hasFlag, readSecret } from '../cli.ts';
import { findPgTools } from './pgTools.ts';
import { ApiClient, freePort, sleep, startNode, stopNode, waitReady } from './procs.ts';
import { runRestoreCheck, type IRestoreStep } from './restore-lib.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const lines: string[] = [];
const log = (line: string): void => {
  lines.push(line);
  console.log(line);
};
const steps: IRestoreStep[] = [];
const record = (name: string, ok: boolean | null, detail: string): void => {
  steps.push({ name, ok: ok !== false, detail });
  log(`${ok === null ? 'NOT_RUN' : ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

const run = (file: string, args: string[]) =>
  new Promise<{ code: number | null; stdout: string }>((done) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000 }, (err, stdout) => done({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout) }));
  });

const stamp = (): string => new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 12);

const main = async (): Promise<number> => {
  const env = process.env;
  const adminUrl = env.RESTORE_ADMIN_URL;
  const storageRoot = env.RESTORE_STORAGE_ROOT;
  if (!adminUrl || !storageRoot) {
    log('нужны RESTORE_ADMIN_URL (суперпользователь кластера проверки) и RESTORE_STORAGE_ROOT (пустой каталог)');
    return 2;
  }
  const backupDir = argValue('backup') ?? (env.BACKUP_ROOT ? await latestCompleteBackup(env.BACKUP_ROOT) : null);
  if (!backupDir) {
    log('не найдена завершённая копия: укажите --backup <каталог> или BACKUP_ROOT');
    return 2;
  }
  const dbName = argValue('db') ?? `kontur_restore_${stamp()}`;
  const login = argValue('login');
  const password = login ? await readSecret(`Пароль ${login}`) : null;
  const tool = await findPgTools({ platform: process.platform, env, run });
  log(`# Проверка восстановления — ${new Date().toISOString()}, ${hostname()}, Node ${process.version}, ${process.platform}`);
  log(`# Копия: ${backupDir}; база проверки: ${dbName}; каталог: ${storageRoot}`);
  if ('error' in tool) {
    record('инструменты PostgreSQL', null, tool.error);
    return 3;
  }
  log(`# Инструмент: ${tool.version} (${tool.mode === 'docker' ? `контейнер ${tool.container}` : 'локально'})`);

  const passwords = { appPassword: env.KONTUR_APP_DB_PASSWORD, migratorPassword: env.KONTUR_MIGRATOR_DB_PASSWORD, backupPassword: env.KONTUR_BACKUP_DB_PASSWORD };
  const r = await runRestoreCheck({
    backupDir,
    adminUrl,
    dbName,
    storageRoot,
    production: { databaseUrl: env.DATABASE_URL, storageRoot: env.STORAGE_ROOT, backupRoot: env.BACKUP_ROOT },
    tool,
    passwords,
    env,
    log: () => undefined,
  });
  for (const s of r.steps) record(s.name, s.ok, s.detail);
  if (!r.ok || !r.pool) return 1;
  const pool = r.pool;

  // Процессы на копии: свой порт, без TLS и интеграций с внешними действиями.
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const childEnv: NodeJS.ProcessEnv = { ...env };
  for (const k of ['TLS_CERT_FILE', 'TLS_KEY_FILE', 'TENDERHUB_URL', 'TENDERHUB_API_KEY', 'INTAKE_ROOTS', 'MAILHUB_URL', 'MAILHUB_TOKEN', 'DATABASE_MIGRATOR_URL', 'DATABASE_ADMIN_URL', 'BACKUP_DATABASE_URL']) delete childEnv[k];
  Object.assign(childEnv, {
    KONTUR_ENV: 'development',
    DATABASE_URL: r.appUrl,
    STORAGE_ROOT: storageRoot,
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: String(port),
    ALLOWED_ORIGINS: base,
    MCP_ENABLED: 'false',
    WORKER_MODE: 'restore_check',
  });
  const worker = startNode('worker', 'apps/worker/src/main.ts', { cwd: ROOT, env: childEnv });
  const server = startNode('server', 'apps/server/src/main.ts', { cwd: ROOT, env: childEnv });
  try {
    const ready = await waitReady(base, 60_000);
    record('server и worker на копии — /ready', ready.ok, JSON.stringify((ready.body as { checks?: unknown } | null)?.checks ?? null));
    if (!ready.ok) return 1;

    const release = await pool.query<{ id: string; tender_id: string; stage_id: string; manifest_sha256: string }>(
      'SELECT id, tender_id, stage_id, release_manifest_blob_sha256 AS manifest_sha256 FROM release ORDER BY released_at DESC LIMIT 1',
    );
    if (!login || !password) {
      record('исторический выпуск, цитата и поиск через API', null, 'не задан --login: проверка от имени пользователя не выполнялась');
    } else {
      const api = new ApiClient(base, base);
      const auth = await api.call('/auth/login', { method: 'POST', body: { login, password } });
      record(`вход ${login} на копии`, auth.status === 200, `HTTP ${auth.status}`);
      const rel = release.rows[0];
      if (!rel) {
        record('исторический выпуск', null, 'в копии нет выпусков');
      } else {
        const view = await api.call(`/releases/${rel.id}`);
        record('исторический выпуск открывается', view.status === 200, `HTTP ${view.status}`);
        const manifest = await api.call(`/releases/${rel.id}/manifest`);
        const bytes = Buffer.from(await manifest.arrayBuffer());
        const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
        record('манифест выпуска совпадает по SHA-256', manifest.status === 200 && sha === rel.manifest_sha256, `HTTP ${manifest.status}, SHA-256 ${sha}`);
      }
      // Цитата и поиск — в тендере выпуска, а без выпусков — в тендере, где --login участник (не зависят от выпуска).
      const frag = await pool.query<{ id: string; text: string; tender_id: string; stage_id: string }>(
        `SELECT f.id, f.text, f.tender_id, s.id AS stage_id
           FROM evidence_fragment f
           JOIN tender_stage s ON s.tender_id = f.tender_id
          WHERE length(f.text) > 20
            AND ($1::uuid IS NULL OR f.tender_id = $1)
            AND EXISTS (SELECT 1 FROM tender_member m JOIN app_user u ON u.id = m.user_id WHERE m.tender_id = f.tender_id AND u.login = $2 AND m.removed_at IS NULL)
          ORDER BY (s.id = $3::uuid) DESC, f.id LIMIT 1`,
        [rel?.tender_id ?? null, login, rel?.stage_id ?? null],
      );
      const f = frag.rows[0];
      if (!f) {
        record('цитата и поиск', null, `у ${login} нет тендера с распознанным текстом в копии`);
      } else {
        const cite = await api.call(`/evidence/${f.id}`);
        record('цитата открывается', cite.status === 200, `HTTP ${cite.status}`);
        const words = f.text.split(/\s+/u).filter((w) => w.length >= 4).slice(0, 3).join(' ');
        const body = { context: { kind: 'tender', tenderId: f.tender_id, mode: 'working', stageId: f.stage_id }, query: words, limit: 5 };
        const first = (await (await api.call('/search', { method: 'POST', body, headers: { 'Idempotency-Key': `restore-${stamp()}-1` } })).json()) as {
          semantic?: { status: string; reason: string | null };
          lexical?: { items: unknown[] } | null;
          fused?: { items: unknown[] } | null;
        };
        const hits = (first.fused?.items ?? first.lexical?.items ?? []).length;
        record('поиск на копии: точный и полнотекстовый', hits > 0, `найдено ${hits}; смысловой — ${first.semantic?.status} (${first.semantic?.reason ?? '—'})`);
        const vectorsWanted = (env.EMBEDDING_PROVIDER ?? 'none') !== 'none';
        if (!vectorsWanted) {
          record('достройка векторов', null, 'модель эмбеддингов не настроена: смысловая ветка останется недоступной (index_without_embeddings / index_vectors_missing)');
        } else {
          const timeoutMs = Number(argValue('vectors-timeout') ?? '1800') * 1000;
          const until = Date.now() + timeoutMs;
          let missing = -1;
          while (Date.now() < until) {
            const m = await pool.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM search_chunk c JOIN search_index_version v ON v.id = c.index_version_id AND v.status = 'active'
                WHERE v.embedding_model IS NOT NULL AND NOT EXISTS (SELECT 1 FROM search_chunk_vector x WHERE x.chunk_id = c.id)`,
            );
            missing = m.rows[0]!.n;
            if (missing === 0) break;
            await sleep(5000);
          }
          const again = (await (await api.call('/search', { method: 'POST', body, headers: { 'Idempotency-Key': `restore-${stamp()}-2` } })).json()) as { semantic?: { status: string } };
          record('достройка векторов и смысловой поиск', missing === 0 && again.semantic?.status !== 'unavailable', `без векторов осталось ${missing}; смысловой — ${again.semantic?.status}`);
        }
      }
    }
  } finally {
    const codes = await Promise.all([stopNode(server, 30_000), stopNode(worker, 30_000)]);
    record('штатная остановка server и worker по IPC', codes.every((c) => c === 0), `коды выхода ${codes.join(', ')}`);
    await pool.end().catch(() => undefined);
  }
  if (hasFlag('drop-after')) {
    await dropDatabase(adminUrl, dbName).catch((e: Error) => log(`база ${dbName} не удалена: ${e.message}`));
    rmSync(join(storageRoot, 'sha256'), { recursive: true, force: true, maxRetries: 5 });
    rmSync(join(storageRoot, 'tmp'), { recursive: true, force: true, maxRetries: 5 });
    rmSync(join(storageRoot, 'derived'), { recursive: true, force: true, maxRetries: 5 });
    log(`# база ${dbName} и восстановленные файлы удалены (--drop-after)`);
  }
  return steps.every((s) => s.ok) ? 0 : 1;
};

main()
  .then((code) => {
    log(`Итог: ${code === 0 ? 'PASS' : code === 3 ? 'NOT_RUN' : 'FAIL'}`);
    const out = argValue('out');
    if (out) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), `${lines.join('\n')}\n`);
    }
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`проверка восстановления прервана: ${err instanceof Error ? err.message : 'unknown'}`);
    process.exitCode = 1;
  });
