// Только чтение JSON-описей; результат создаётся новым файлом. Сервисами и БД не управляет.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { auditLocusCorpus, LocusPreflightInputError } from '../lib/locus-corpus-audit.mjs';

try {
  const { values } = parseArgs({ options: { locus: { type: 'string' }, portal: { type: 'string' }, crosswalk: { type: 'string' }, out: { type: 'string' } }, strict: true, allowPositionals: false });
  if (!values.locus || !values.out) throw new LocusPreflightInputError('USAGE_LOCUS_AND_OUT_REQUIRED');
  const input = {}, inputSha256 = {};
  for (const key of ['locus', 'portal', 'crosswalk']) {
    if (!values[key]) continue;
    const raw = await readFile(values[key]);
    inputSha256[key] = createHash('sha256').update(raw).digest('hex');
    try { input[key] = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/u, '')); }
    catch { throw new LocusPreflightInputError('INVALID_JSON'); }
  }
  const report = { ...auditLocusCorpus(input), createdAt: new Date().toISOString(), inputSha256 };
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ comparison: report.comparison, summary: report.summary, liveVerification: report.liveVerification, retirementAllowed: report.retirementAllowed }));
  process.exitCode = report.comparison === 'MATCH' ? 0 : 2;
} catch (error) {
  // Ни произвольные значения входа, ни содержимое ошибок файлового пути в консоль не попадают.
  const code = error instanceof LocusPreflightInputError ? error.code : ['ENOENT', 'EEXIST', 'EACCES', 'EISDIR'].includes(error?.code) ? error.code : 'PREFLIGHT_FAILED';
  console.error(JSON.stringify({ error: code })); process.exitCode = 1;
}
