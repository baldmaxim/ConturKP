// Сверка папки выпуска с признаком готовности (этап 14; D-034; проект §16): для проверки облака Яндекс Диска — папку,
// скачанную из веб-интерфейса Диска (или открытую на другом устройстве), сверяют с её kontur-placement.json:
//   npm run delivery:compare -- <папка> [--marker-sha256 <SHA-256 признака из журнала живой проверки или карточки>]
// Каждый файл признака — есть, размер и SHA-256 совпадают; посторонних файлов нет (служебные файлы оболочки ОС не
// считаются); признак — каноническая запись схемы kontur-placement/1; с --marker-sha256 — байты признака те же, что
// записал портал. Полных путей в выводе нет. Код выхода: 0 — совпадает, 1 — расхождение, 2 — неверный запуск.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, PLACEMENT_MARKER, PLACEMENT_SCHEMA, type IPlacementManifest } from '../packages/core/src/index.ts';
import { argValue } from './cli.ts';

const SHELL_FILES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

const hashFile = async (p: string): Promise<string> => {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest('hex');
};

const run = async (): Promise<number> => {
  const folderArg = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--marker-sha256');
  if (!folderArg) {
    console.error('Использование: npm run delivery:compare -- <папка> [--marker-sha256 <sha>]');
    return 2;
  }
  const folder = resolve(folderArg);
  const markerPath = join(folder, PLACEMENT_MARKER);
  if (!existsSync(markerPath)) {
    console.log(`[FAIL] в папке нет признака готовности ${PLACEMENT_MARKER}`);
    return 1;
  }
  let ok = true;
  const line = (pass: boolean, text: string) => {
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${text}`);
    ok &&= pass;
  };
  const bytes = readFileSync(markerPath);
  let manifest: IPlacementManifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8')) as IPlacementManifest;
  } catch {
    line(false, 'признак готовности — не JSON');
    return 1;
  }
  line(manifest.schema === PLACEMENT_SCHEMA && canonicalJson(manifest) === bytes.toString('utf8'), `признак: схема ${String(manifest.schema)}, каноническая запись`);
  const expected = argValue('marker-sha256');
  if (expected) line(createHash('sha256').update(bytes).digest('hex') === expected.toLowerCase(), 'признак: SHA-256 совпадает с записанным порталом');
  for (const f of manifest.files ?? []) {
    const p = join(folder, f.path);
    if (!existsSync(p) || !statSync(p).isFile()) {
      line(false, `«${f.path}»: нет файла`);
      continue;
    }
    const size = statSync(p).size;
    const digest = await hashFile(p);
    line(size === f.size && digest === f.sha256, `«${f.path}»: ${size === f.size && digest === f.sha256 ? 'размер и SHA-256 совпадают' : `размер ${size} (ожидался ${f.size}), SHA-256 ${digest.slice(0, 12)}… (ожидался ${f.sha256.slice(0, 12)}…)`}`);
  }
  const known = new Set([...(manifest.files ?? []).map((f) => f.path), PLACEMENT_MARKER]);
  const extra = readdirSync(folder).filter((n) => !known.has(n) && !SHELL_FILES.has(n.toLowerCase()));
  line(extra.length === 0, extra.length === 0 ? 'посторонних файлов нет' : `посторонние файлы: ${extra.slice(0, 10).join(', ')}`);
  console.log(`Итог: ${ok ? 'PASS' : 'FAIL'} (${manifest.files?.length ?? 0} файлов, выпуск ${String(manifest.release?.id ?? '—')})`);
  return ok ? 0 : 1;
};

process.exitCode = await run();
