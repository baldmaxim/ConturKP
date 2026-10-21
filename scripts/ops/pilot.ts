// npm run ops:pilot -- candidate --tender <uuid>
// npm run ops:pilot -- reference-seal --file <эталон.json>
// npm run ops:pilot -- report --tender <uuid> --reference <эталон.json> --sealed <sha256> --matching <сопоставление.json>
//                             [--out <каталог>] [--timelog <журнал.csv>] [--defects <docs/defects.md>]
// Инструменты пилота (этап 18, проект docs/architecture/18-pilot-design.md §5–§6). Все команды только читают рабочую
// базу (DATABASE_URL): сеанс default_transaction_read_only = on, одна транзакция READ ONLY, записей и заданий нет.
// Названий, текстов источников, ФИО и почт в выводе нет — идентификаторы и счётчики; адрес БД не печатается.
// Формат эталона и сопоставления — docs/pilot/reference-template.json, docs/pilot/matching-template.json.
// Код выхода: 0 — готово (candidate: SUITABLE; report: нет FAIL), 1 — отказ, ошибка схемы или FAIL/INCOMPLETE,
// 2 — неверный запуск.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { argValue } from '../cli.ts';
import { compareActivity, parseTimelog, type ITimelogRow } from './pilot-activity.ts';
import { evaluateCandidate, renderCandidate } from './pilot-candidate.ts';
import {
  evaluateG1,
  evaluateG2,
  evaluateG3,
  evaluateG4,
  evaluateG5,
  evaluateG6,
  evaluateG7,
  evaluateM1,
  evaluateM2,
  evaluateM3,
  evaluateM4,
  evaluateM5,
  parseDefects,
  type IDefectsSummary,
  type ReasonStatus,
} from './pilot-gates.ts';
import { PilotError, type IResult } from './pilot-lib.ts';
import { buildReport, renderReportMarkdown } from './pilot-report.ts';
import { assertSealed, crossCheck, isUuid, parseJson, referenceStats, sha256Hex, validateMatching, validateReference } from './pilot-schema.ts';
import {
  collectActivity,
  collectCandidate,
  collectG2,
  collectG3,
  collectG4,
  collectG5,
  collectReasonStatuses,
  portalFindingIds,
  section,
  tenderExists,
  withReadOnly,
  type Section,
} from './pilot-db.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const USAGE = 'команды: candidate --tender <uuid> | reference-seal --file <путь> | report --tender <uuid> --reference <путь> --sealed <sha256> --matching <путь> [--out <каталог>] [--timelog <csv>] [--defects <путь>]';

class UsageError extends Error {}

const need = (name: string): string => {
  const v = argValue(name);
  if (!v || v.startsWith('--')) throw new UsageError(`нужен --${name}`);
  return v;
};
const databaseUrl = (): string => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new UsageError('не задан DATABASE_URL');
  return url;
};

const tenderArg = (): string => {
  const t = need('tender');
  if (!isUuid(t)) throw new UsageError('--tender: ожидается uuid тендера портала');
  return t.toLowerCase();
};

const readText = (path: string, what: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new PilotError(`${what}: файл не прочитан (${path})`);
  }
};

const candidate = async (): Promise<number> => {
  const tenderId = tenderArg();
  const url = databaseUrl();
  const result = await withReadOnly(url, async (db) => {
    if (!(await tenderExists(db, tenderId))) throw new PilotError('тендер с таким идентификатором в портале не найден');
    return evaluateCandidate(await collectCandidate(db, tenderId));
  });
  console.log(renderCandidate(result));
  return result.verdict === 'SUITABLE' ? 0 : 1;
};

const referenceSeal = (): number => {
  const file = need('file');
  const bytes = (() => {
    try {
      return readFileSync(file);
    } catch {
      throw new PilotError(`файл не прочитан (${file})`);
    }
  })();
  const checked = validateReference(parseJson(bytes.toString('utf8'), 'эталон'));
  if (!checked.ok) {
    console.error('схема эталона не пройдена:');
    for (const e of checked.errors) console.error(`  - ${e}`);
    return 1;
  }
  const stats = referenceStats(checked.value);
  console.log(`SHA-256: ${sha256Hex(bytes)}`);
  console.log(`пунктов: ${stats.items}`);
  console.log(`критических: ${stats.critical}`);
  return 0;
};

const unavailable = (id: string, title: string, error: string): IResult => ({
  id,
  title,
  status: 'NOT_AVAILABLE',
  value: null,
  threshold: null,
  detail: `не выполнено: ${error}`,
  data: {},
});

const report = async (): Promise<number> => {
  const tenderId = tenderArg();
  const url = databaseUrl();
  const referencePath = need('reference');
  const sealed = need('sealed');
  const matchingPath = need('matching');
  const outDir = resolve(argValue('out') ?? '.');

  // Печать сверяется до чтения базы: изменённый эталон отчёта не получает.
  const referenceBytes = (() => {
    try {
      return readFileSync(referencePath);
    } catch {
      throw new PilotError(`эталон: файл не прочитан (${referencePath})`);
    }
  })();
  const referenceSha = sha256Hex(referenceBytes);
  assertSealed(referenceSha, sealed);

  const reference = validateReference(parseJson(referenceBytes.toString('utf8'), 'эталон'));
  if (!reference.ok) throw new PilotError(`схема эталона не пройдена: ${reference.errors.join('; ')}`);
  const matchingBytes = (() => {
    try {
      return readFileSync(matchingPath);
    } catch {
      throw new PilotError(`сопоставление: файл не прочитан (${matchingPath})`);
    }
  })();
  const matching = validateMatching(parseJson(matchingBytes.toString('utf8'), 'сопоставление'));
  if (!matching.ok) throw new PilotError(`схема сопоставления не пройдена: ${matching.errors.join('; ')}`);
  if (reference.value.tenderId.toLowerCase() !== tenderId) throw new PilotError('--tender не совпадает с tenderId эталона');
  const problems = crossCheck(reference.value, matching.value);
  if (problems.length > 0) throw new PilotError(`эталон и сопоставление не согласованы: ${problems.join('; ')}`);

  let timelog: ITimelogRow[] | null = null;
  const timelogPath = argValue('timelog');
  if (timelogPath) {
    const parsed = parseTimelog(readText(timelogPath, 'журнал участников'));
    if (parsed.errors.length > 0) throw new PilotError(`журнал участников: ${parsed.errors.join('; ')}`);
    timelog = parsed.rows;
  }

  const defectsPath = resolve(argValue('defects') ?? join(ROOT, 'docs', 'defects.md'));
  let defects: IDefectsSummary | null = null;
  try {
    defects = parseDefects(readFileSync(defectsPath, 'utf8'));
  } catch {
    defects = null;
  }

  const ref = reference.value;
  const mat = matching.value;
  const reasonIds = [...new Set(mat.items.filter((i) => ref.items.find((r) => r.id === i.id)?.kind === 'price_reason').flatMap((i) => i.found))];

  const data = await withReadOnly(url, async (db) => {
    if (!(await tenderExists(db, tenderId))) throw new PilotError('тендер с таким идентификатором в портале не найден');
    return {
      findings: await section(db, () => portalFindingIds(db, tenderId)),
      g2: await section(db, () => collectG2(db, tenderId)),
      g3: await section(db, () => collectG3(db, tenderId)),
      g4: await section(db, () => collectG4(db, tenderId)),
      g5: await section(db, () => collectG5(db, tenderId)),
      reasons: await section(db, () => collectReasonStatuses(db, tenderId, reasonIds)),
      activity: await section(db, () => collectActivity(db, tenderId)),
    };
  });

  const notAvailable: string[] = [];
  const via = <T>(s: Section<T>, id: string, title: string, make: (v: T) => IResult): IResult => {
    if (s.ok) return make(s.value);
    notAvailable.push(`${id}: запрос не выполнен (${s.error})`);
    return unavailable(id, title, s.error);
  };

  const gates: IResult[] = [
    evaluateG1(ref, mat),
    via(data.g2, 'G2', 'нет выдуманных источников в принятых выводах', (v) => evaluateG2(v.checks, v.conclusions, false)),
    via(data.g3, 'G3', 'нет утечек между тендерами и этапами', (v) => evaluateG3(v.violations, v.checked)),
    via(data.g4, 'G4', 'денежная сверка проходит', (v) => evaluateG4(v)),
    via(data.g5, 'G5', 'одобренные файлы совпадают с размещёнными', (v) => evaluateG5(v)),
    evaluateG6(),
    evaluateG7(defects),
  ];
  if (defects === null) notAvailable.push(`G7: журнал дефектов не прочитан (${defectsPath})`);

  const portalFindings = data.findings.ok ? data.findings.value : null;
  if (!data.findings.ok) notAvailable.push(`M2: замечания портала не прочитаны (${data.findings.error}); покрытие разметки не проверено`);
  const reasonStatuses = data.reasons.ok ? data.reasons.value : new Map<string, ReasonStatus>();
  if (!data.reasons.ok) notAvailable.push(`M4: причины портала не прочитаны (${data.reasons.error})`);
  const activity = data.activity.ok ? compareActivity(data.activity.value, timelog) : [];
  if (!data.activity.ok) notAvailable.push(`M5: журнал аудита не прочитан (${data.activity.error})`);

  const metrics: IResult[] = [
    evaluateM1(ref, mat),
    evaluateM2(mat, portalFindings),
    evaluateM3(mat),
    data.reasons.ok ? evaluateM4(ref, mat, reasonStatuses) : unavailable('M4', 'причины изменения цены', data.reasons.error),
    evaluateM5(activity, timelog !== null),
  ];

  notAvailable.push('G2: дословность цитаты не проверялась — цитата отдельно от фрагмента в БД не хранится для замечаний и ответов (finding_evidence, answer_evidence); проверены принадлежность фрагмента источнику тендера и вход этапа или прогона поиска');
  const limitations = [
    'G2: принятое замечание — status resolved или accepted_risk; принятый ответ — завершённый прогон со статусом confirmed_by_citations',
    'G2/G3: источником тендера считается фрагмент тендера или договора, активно связанного с тендером (contract_tender)',
    'G4: берётся последняя по времени ревизия расчёта тендера и последний отчёт revision_economics по ней',
    'G5: размещения со статусом superseded не учитываются; проверяется remote_state каждого файла набора (в том числе манифесты и признак готовности)',
    'M2: показанные замечания — все замечания тендера со статусом, отличным от stale; замечание без разметки даёт FAIL',
    'M4: для пунктов price_reason found — идентификаторы версий причины портала (change_explanation.id); пропущенный пункт не засчитывается',
    'M5: интервалы активности — по audit_event человека с исходом allowed по участникам тендера; разрыв более 15 минут — новый интервал; сравнение с журналом — по суммам минут пользователя',
  ];

  const result = buildReport({
    generatedAt: new Date().toISOString(),
    tenderId,
    referenceSha256: referenceSha,
    matchingSha256: sha256Hex(matchingBytes),
    referenceStats: referenceStats(ref),
    gates,
    metrics,
    notAvailable,
    limitations,
  });
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'pilot-report.json');
  const mdPath = join(outDir, 'pilot-report.md');
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(mdPath, renderReportMarkdown(result));

  for (const r of [...gates, ...metrics]) console.log(`${r.status.padEnd(13)} ${r.id}  ${r.title} — ${r.detail}`);
  console.log(`отчёт: ${jsonPath}`);
  console.log(`отчёт: ${mdPath}`);
  return result.summary.failed.length > 0 ? 1 : 0;
};

const main = async (): Promise<number> => {
  const command = process.argv[2];
  try {
    if (command === 'candidate') return await candidate();
    if (command === 'reference-seal') return referenceSeal();
    if (command === 'report') return await report();
    throw new UsageError(USAGE);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      return 2;
    }
    console.error(err instanceof PilotError ? `отказ: ${err.message}` : `ошибка: ${err instanceof Error ? err.message : 'неизвестная ошибка'}`);
    return 1;
  }
};

void main().then((code) => {
  process.exitCode = code;
});
