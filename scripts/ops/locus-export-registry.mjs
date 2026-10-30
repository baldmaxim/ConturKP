// Только чтение файлов в явно перечисленных корнях. Результаты — новые частные файлы.
import { readFile, open, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve, basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { exportLocusRegistry, validateLocusRegistryExport, withinRoot } from '../lib/locus-registry-export.mjs';

async function physicalOutputPath(file) {
  const suffix = [];
  for (let current = resolve(file); ; current = dirname(current)) {
    try { return join(await realpath(current), ...suffix); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code) || dirname(current) === current) throw error;
      suffix.unshift(basename(current));
    }
  }
}

let resultHandle, progressHandle;
try {
  const options = Object.fromEntries(['registry', 'sources', 'out', 'max-bytes', 'max-ms', 'concurrency'].map(key => [key, { type: 'string' }]));
  const { values } = parseArgs({ options, strict: true, allowPositionals: false });
  if (!values.registry || !values.sources || !values.out) throw new Error('USAGE_REGISTRY_SOURCES_OUT_REQUIRED');
  const registryBytes = await readFile(values.registry), sourceBytes = await readFile(values.sources);
  const registry = JSON.parse(registryBytes.toString('utf8').replace(/^\uFEFF/u, ''));
  const sourceCatalog = JSON.parse(sourceBytes.toString('utf8').replace(/^\uFEFF/u, ''));
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const exportOptions = { registry, sourceCatalog, snapshotId: 'indexed-' + sha(registryBytes) + '-' + Date.now(),
    maxBytes: values['max-bytes'] === undefined ? undefined : Number(values['max-bytes']),
    maxDurationMs: values['max-ms'] === undefined ? undefined : Number(values['max-ms']),
    concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency) };
  validateLocusRegistryExport(exportOptions); // никаких выходных файлов до полной проверки входа
  const output = resolve(values.out), progressOutput = output + '.progress.jsonl';
  const physicalOutput = await physicalOutputPath(output), physicalProgress = await physicalOutputPath(progressOutput);
  for (const source of sourceCatalog.sources ?? []) {
    for (const root of source.roots ?? []) {
      const physicalRoot = await physicalOutputPath(root);
      if (withinRoot(root, output) || withinRoot(root, progressOutput) || withinRoot(physicalRoot, physicalOutput) || withinRoot(physicalRoot, physicalProgress)) throw new Error('OUTPUT_INSIDE_SOURCE_ROOT');
    }
  }
  await mkdir(dirname(output), { recursive: true });
  // wx запрещает перезапись оригинала, входа или прежнего результата.
  resultHandle = await open(output, 'wx');
  progressHandle = await open(progressOutput, 'wx');
  let progressWrites = Promise.resolve();
  const report = await exportLocusRegistry({
    ...exportOptions,
    onProgress: progress => {
      progressWrites = progressWrites.then(() => progressHandle.write(JSON.stringify(progress) + '\n'));
      if (progress.processed % 50 === 0 || progress.processed === progress.total) console.log(JSON.stringify(progress));
      return progressWrites;
    },
  });
  await resultHandle.writeFile(JSON.stringify({ ...report, inputSha256: { registry: sha(registryBytes), sources: sha(sourceBytes) } }, null, 2) + '\n');
  console.log(JSON.stringify({ exportMode: report.exportMode, complete: report.complete, statistics: report.statistics }));
  process.exitCode = 2;
} catch (error) {
  const allowed = new Set(['EEXIST', 'ENOENT', 'EACCES', 'USAGE_REGISTRY_SOURCES_OUT_REQUIRED', 'OUTPUT_INSIDE_SOURCE_ROOT', 'INVALID_EXPORT_LIMIT', 'INVALID_REGISTRY_EXPORT_INPUT', 'INVALID_SOURCE_CATALOG', 'INVALID_REGISTRY_ENTRY', 'ABSOLUTE_ORIGINAL_PATH_REQUIRED', 'DUPLICATE_SOURCE_ID']);
  const code = allowed.has(error?.code) ? error.code : allowed.has(error?.message) ? error.message : 'REGISTRY_EXPORT_FAILED';
  console.error(JSON.stringify({ error: code })); process.exitCode = 1;
} finally {
  await resultHandle?.close(); await progressHandle?.close();
}
