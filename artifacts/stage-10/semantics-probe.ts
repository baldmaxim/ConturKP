// Живая проба семантики TenderHub (этап 10, подготовка; docs/integrations/tenderhub-economics-semantics.md).
// Выгрузка — адаптером и стратегией этапа 06 (runPortalCapture), только GET по X-API-Key; БД портала не используется.
// Данные кладутся во временную БД кластера разработки, проверки — artifacts/stage-10/semantics-probe.sql (numeric),
// временная БД удаляется. В журнал — вердикты, счётчики, классы величин и номер тендера; сумм, названий, ключа и
// полных uuid нет. Статус интеграции скрипт не меняет.
//   node --env-file-if-exists=.env artifacts/stage-10/semantics-probe.ts [--number 338] [--multi <номер>]
// Без --multi выбирается номер с ≥ 2 версиями из /tenders/brief (не архивный, самый свежий по updated_at).
// Завершение — естественное (process.exitCode), см. R08-07.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';
import {
  runPortalCapture,
  TENDERHUB_CONTRACT_VERSION,
  TenderHubApiSource,
  TenderHubError,
  TenderHubHttpClient,
  type IPortalCaptureResult,
  type ISourceBrief,
} from '../../packages/adapters/src/index.ts';
import type { ICalcContent, ICalcLine } from '../../packages/core/src/index.ts';
import { loadTenderHubConfig } from '../../packages/config/src/index.ts';

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, '..', '..');
const OUT = join(ROOT, 'artifacts', 'stage-10', 'semantics-probe.log');
const SQL = join(HERE, 'semantics-probe.sql');
const ADMIN_URL = process.env.KONTUR_TEST_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';
// SHA-256 backend/internal/handlers/openapi/archive.yaml на HUBTender 0611f20 (и живой сборки 2026-09-29, этап 06).
const HEAD_OPENAPI_SHA = '3b038e3021288884ff27956aee8560a8516181f06a765fb93ee82399c071faa5';
// Тендер этапа 06 (маскированный uuid из artifacts/stage-06/live-smoke.log).
const STAGE06 = { head: 'fd1b67c9', tail: '711d' };
const UUID_RE = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8}([0-9a-f]{4})\b/giu;

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const out: string[] = [];
const sensitive = new Set<string>();
const line = (mark: string, check: string, detail: string): void => {
  out.push(`${mark.padEnd(5)} ${check} — ${detail}`);
};
const errorText = (err: unknown): string =>
  err instanceof TenderHubError ? `${err.error.code}/${err.error.reason}` : err instanceof Error ? err.name : 'ошибка';

const norm = (s: string | null): string => (s ?? '').toLowerCase().trim().split(/\s+/u).filter(Boolean).join(' ');
const isWork = (t: string): boolean => t === 'раб' || t === 'суб-раб' || t === 'раб-комп.';
const nameId = (l: ICalcLine): string => (isWork(l.itemType) ? l.workNameId : l.materialNameId) ?? l.workNameId ?? l.materialNameId ?? '';
const shallow = (l: ICalcLine): string => [l.itemType, nameId(l), norm(l.unitCode)].join('\x1e');

// Ключи HUBTender analytics/changeimpact/keys.go:9-50 и clone-join repository/tender_clone.go:101-118.
const rowsOf = (tag: string, c: ICalcContent): { positions: unknown[][]; lines: unknown[][] } => {
  const byId = new Map(c.lines.map((l) => [l.externalItemId, l]));
  const positions = c.positions.map((p) => [
    tag, p.externalPositionId, [norm(p.itemNo), norm(p.workName), norm(p.unitCode)].join('\x1f'),
    [p.positionNumber, String(p.isAdditional), p.workName].join('\x1f'), p.volume, p.manualVolume, p.isSection, p.isAdditional,
    p.totalMaterial, p.totalWorks, p.materialCostPerUnit, p.workCostPerUnit, p.totalCommercialMaterial, p.totalCommercialWork,
    p.totalCommercialMaterialPerUnit, p.totalCommercialWorkPerUnit, p.baseTotal, p.commercialTotal, p.materialCostTotal,
    p.workCostTotal, p.markupPercentage, p.itemsCount,
  ]);
  const lines = c.lines.map((l) => {
    const parent = l.parentWorkExternalItemId ? byId.get(l.parentWorkExternalItemId) : undefined;
    const lkey = [l.itemType, nameId(l), norm(l.unitCode), l.detailCostCategoryId ?? '', parent ? shallow(parent) : '', norm(l.description)].join('\x1f');
    return [
      tag, l.externalItemId, l.externalPositionId, l.itemType, l.materialType, lkey, l.parentWorkExternalItemId, l.quantity,
      l.consumptionCoefficient, l.conversionCoefficient, l.unitRate, l.currency, l.deliveryPriceType, l.deliveryAmount,
      l.totalAmount, l.commercialMarkup, l.totalCommercialMaterial, l.totalCommercialWork, l.baseQuantity,
    ];
  });
  return { positions, lines };
};

const insertRows = async (client: pg.Client, table: string, rows: unknown[][]): Promise<void> => {
  if (rows.length === 0) return;
  const width = rows[0]!.length;
  const chunk = Math.floor(30000 / width);
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const values = part.map((_, r) => `(${Array.from({ length: width }, (_, k) => `$${r * width + k + 1}`).join(', ')})`).join(', ');
    await client.query(`INSERT INTO ${table} VALUES ${values}`, part.flat());
  }
};

const sections = (): { name: string; sql: string }[] => {
  const text = readFileSync(SQL, 'utf8');
  return text
    .split(/^-- name: /mu)
    .slice(1)
    .map((chunk) => {
      const nl = chunk.indexOf('\n');
      return { name: chunk.slice(0, nl).trim(), sql: chunk.slice(nl + 1).trim() };
    });
};

const run = async (): Promise<number> => {
  const { tenderhub: th, problems } = loadTenderHubConfig();
  if (problems.length > 0 || !th.baseUrl || !th.apiKey) {
    line('INFO', 'tenderhub', `NOT_RUN: TENDERHUB_URL ${th.baseUrl ? 'задан' : 'не задан'}, TENDERHUB_API_KEY ${th.apiKey ? 'задан' : 'не задан'}`);
    return 3;
  }
  sensitive.add(th.apiKey);
  const http = new TenderHubHttpClient({
    baseUrl: th.baseUrl,
    apiKey: th.apiKey,
    timeoutMs: th.timeoutMs,
    rateLimitPerMinute: th.rateLimitPerMinute,
    windowMs: th.rateLimitWindowMs,
    maxResponseBytes: th.maxResponseBytes,
    rateLimitWaits: 2,
  });

  out.push('## 1. Сборка');
  try {
    const spec = await http.get('openapi', '/api/v1/archive/openapi.yaml');
    const sha = createHash('sha256').update(spec.body).digest('hex');
    line(sha === HEAD_OPENAPI_SHA ? 'PASS' : 'INFO', 'openapi', `SHA-256 ${sha}; ${sha === HEAD_OPENAPI_SHA ? 'совпадает' : 'не совпадает'} с archive.yaml HUBTender 0611f20 (коммит бэкенда сборки по ответам не определяется)`);
  } catch (err) {
    line('FAIL', 'openapi', errorText(err));
  }

  out.push('## 2. Выбор тендеров (/tenders/brief)');
  let brief: ISourceBrief[] = [];
  try {
    brief = (await new TenderHubApiSource(http).brief('')).value;
  } catch (err) {
    line('FAIL', 'brief', errorText(err));
    return 1;
  }
  for (const b of brief) {
    if (b.title) sensitive.add(b.title);
    if (b.clientName) sensitive.add(b.clientName);
  }
  const byNumber = new Map<string, ISourceBrief[]>();
  for (const b of brief) byNumber.set(b.tenderNumber, [...(byNumber.get(b.tenderNumber) ?? []), b]);
  const multi = [...byNumber.entries()].filter(([, v]) => new Set(v.map((b) => b.version)).size >= 2);
  line('INFO', 'brief', `тендеров ${brief.length}, номеров ${byNumber.size}, номеров с ≥ 2 версиями ${multi.length}`);

  const numberA = arg('number') ?? '338';
  const rowsA = byNumber.get(numberA) ?? [];
  const a = rowsA.find((b) => b.id.startsWith(STAGE06.head) && b.id.endsWith(STAGE06.tail)) ?? rowsA.find((b) => b.version === 1) ?? rowsA[0];
  if (!a) {
    line('FAIL', 'tender.A', `номер ${numberA} в brief не найден`);
    return 1;
  }
  line('INFO', 'tender.A', `№ ${numberA} v${a.version ?? '—'}${a.id.startsWith(STAGE06.head) ? ' — тот же тендер, что на этапе 06' : ''}; версий у номера ${rowsA.length}`);

  const multiArg = arg('multi');
  const recent = (v: ISourceBrief[]): string => v.map((b) => b.updatedAt ?? '').sort().at(-1) ?? '';
  const pick = multiArg
    ? multi.find(([n]) => n === multiArg)
    : [...multi].sort(([, x], [, y]) => Number(x.every((b) => b.isArchived)) - Number(y.every((b) => b.isArchived)) || recent(y).localeCompare(recent(x)))[0];
  let pair: [ISourceBrief, ISourceBrief] | null = null;
  if (pick) {
    const versions = [...pick[1]].sort((x, y) => (x.version ?? 0) - (y.version ?? 0));
    pair = [versions.at(-2)!, versions.at(-1)!];
    line('INFO', 'tender.B', `№ ${pick[0]}: B1 = v${pair[0].version}, B2 = v${pair[1].version}; версий у номера ${versions.length}; архивный: ${pick[1].every((b) => b.isArchived) ? 'да' : 'нет'}`);
  } else {
    line('INFO', 'tender.B', 'номера с ≥ 2 версиями нет — L7 не выполняется');
  }

  out.push('## 3. Выгрузка (runPortalCapture, этап 06)');
  const targets: [string, ISourceBrief][] = [['A', a], ...(pair ? ([['B1', pair[0]], ['B2', pair[1]]] as [string, ISourceBrief][]) : [])];
  const captured = new Map<string, IPortalCaptureResult>();
  for (const [tag, b] of targets) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const r = await runPortalCapture(new TenderHubApiSource(http), b.id);
        if (r.observed.title) sensitive.add(r.observed.title);
        if (r.observed.clientName) sensitive.add(r.observed.clientName);
        const missing = Object.entries(r.consistency.missingFields).filter(([, n]) => n > 0).map(([f, n]) => `${f} ×${n}`);
        line(r.content ? 'PASS' : 'FAIL', `capture.${tag}`, `попытка ${attempt}: ${r.consistency.outcome}; позиций ${r.consistency.counts.positionsWithCosts}, строк ${r.consistency.counts.boqItems}; отсутствующие необязательные поля: ${missing.length ? missing.join(', ') : 'нет'}`);
        if (r.content) {
          captured.set(tag, r);
          break;
        }
        for (const reason of r.consistency.reasons.slice(0, 3)) line('INFO', `capture.${tag}.reason`, reason.code);
      } catch (err) {
        line('FAIL', `capture.${tag}`, `попытка ${attempt}: ${errorText(err)}`);
      }
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  }
  if (!captured.has('A')) return 1;

  out.push('## 4. Проверки (semantics-probe.sql, numeric)');
  const dbName = `kontur_probe10_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  let failed = false;
  try {
    await admin.query(`CREATE DATABASE ${dbName} TEMPLATE template0 ENCODING 'UTF8'`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const [schema, ...checks] = sections();
      await client.query(schema!.sql);
      for (const [tag, r] of captured) {
        const h = r.content!.header;
        await client.query('INSERT INTO p_tender VALUES ($1, $2, $3, $4, $5)', [tag, h.sourceGrandTotal, h.usdRate, h.eurRate, h.cnyRate]);
        const rows = rowsOf(tag, r.content!);
        await insertRows(client, 'p_position', rows.positions);
        await insertRows(client, 'p_line', rows.lines);
      }
      for (const check of checks) {
        if (check.name.startsWith('L7') && !(captured.has('B1') && captured.has('B2'))) continue;
        const res = await client.query<{ check: string; tag: string; mark: string; detail: string }>(check.sql);
        for (const row of res.rows) {
          if (row.mark === 'FAIL') failed = true;
          line(row.mark, `${row.check} [${row.tag}]`, row.detail);
        }
      }
    } finally {
      await client.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }
  return failed ? 1 : 0;
};

let code: number;
try {
  code = await run();
} catch (err) {
  line('FAIL', 'probe', err instanceof Error ? `${err.name}: ${err.message}` : 'ошибка');
  code = 1;
}
const body = out.map((l) => l.replace(UUID_RE, '$1-…-$2'));
const leaked = body.filter((l) => [...sensitive].some((s) => s.length >= 4 && l.includes(s))).length;
const text = [
  `# tenderhub semantics probe (этап 10) — ${new Date().toISOString()}`,
  `# адаптер ${TENDERHUB_CONTRACT_VERSION}; только GET; сумм, названий, ключа и полных uuid нет`,
  ...(leaked === 0 ? body : ['FAIL  log_redaction — журнал содержит чувствительные значения, тело не записано']),
  `Итог: ${code === 0 ? 'PASS' : code === 3 ? 'NOT_RUN' : 'FAIL (см. FAIL выше)'}`,
  '',
].join('\n');
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
process.stdout.write(`${text}журнал — ${OUT}\n`);
process.exitCode = leaked === 0 ? code : 1;
