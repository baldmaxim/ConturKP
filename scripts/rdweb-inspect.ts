// node scripts/rdweb-inspect.ts <путь к экспортному архиву RDWeb>
// Реализация inspect() из docs/contracts/adapters.md §3: печатает счётчики и предупреждения
// разбора, не записывая ничего в БД и хранилище и не обращаясь в сеть. Нужен, чтобы сверить
// настоящий образец экспорта, не внося конфиденциальный файл в репозиторий (Q-02, R-05).
import { createHash } from 'node:crypto';
import { importRdwebExport, inspectRdwebBlocks, type IRdwebArchive } from '../packages/adapters/src/index.ts';
import { ArchiveOpenError, readZip } from '../apps/worker/src/archive.ts';
import { pdfPageCountOfBytes } from '../apps/worker/src/pdfPages.ts';
import { classifyMember, pickMember } from '../packages/adapters/src/rdweb/members.ts';

const path = process.argv[2];
if (!path) {
  console.error('укажите путь к архиву: node scripts/rdweb-inspect.ts <файл.zip>');
  process.exit(2);
}

const readAll = async (source: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const archive: IRdwebArchive = {
  pdf: null,
  blocksJson: null,
  resultsMd: null,
  resultsHtmlPresent: false,
  extras: [],
  ignored: [],
  unsafe: [],
  corrupt: null,
  groupMismatch: null,
};
const pdfs = new Map<string, { score: number; sha256: string; bytes: Uint8Array }>();
const jsons = new Map<string, { score: number; text: string }>();
const mds = new Map<string, { score: number; text: string }>();

try {
  await readZip(path, async (entry) => {
    if (entry.kind === 'rejected') {
      archive.unsafe.push({ memberPath: entry.memberPath, detail: `${entry.reason}: ${entry.detail}` });
      return 'continue';
    }
    const { role, score } = classifyMember(entry.memberPath);
    if (role === 'other') {
      archive.extras.push(entry.memberPath);
      return 'continue';
    }
    if (role === 'results_html') {
      archive.resultsHtmlPresent = true;
      return 'continue';
    }
    const data = await readAll(await entry.open());
    if (role === 'pdf') pdfs.set(entry.memberPath, { score, sha256: createHash('sha256').update(data).digest('hex'), bytes: new Uint8Array(data) });
    else if (role === 'blocks_json') jsons.set(entry.memberPath, { score, text: data.toString('utf8') });
    else mds.set(entry.memberPath, { score, text: data.toString('utf8') });
    return 'continue';
  });
} catch (err) {
  if (!(err instanceof ArchiveOpenError)) throw err;
  archive.corrupt = err.message;
}

const candidates = (m: Map<string, { score: number }>) => [...m].map(([memberPath, v]) => ({ memberPath, score: v.score }));
const pdf = pickMember(candidates(pdfs));
const json = pickMember(candidates(jsons));
const md = pickMember(candidates(mds));
archive.pdf = pdf.chosen ? { memberPath: pdf.chosen.memberPath, sha256: pdfs.get(pdf.chosen.memberPath)!.sha256 } : null;
archive.blocksJson = json.chosen ? jsons.get(json.chosen.memberPath)!.text : null;
archive.resultsMd = md.chosen ? mds.get(md.chosen.memberPath)!.text : null;
archive.ignored = [...pdf.ignored, ...json.ignored, ...md.ignored];

console.log(`архив: ${path}`);
console.log(`PDF: ${archive.pdf?.memberPath ?? 'нет'}${archive.pdf ? ` (sha256 ${archive.pdf.sha256.slice(0, 16)}…)` : ''}`);
console.log(`_blocks.json: ${json.chosen?.memberPath ?? 'нет'}; _results.md: ${md.chosen?.memberPath ?? 'нет'}; _results.html: ${archive.resultsHtmlPresent ? 'есть' : 'нет'}`);
if (archive.extras.length) console.log(`лишние члены: ${archive.extras.join(', ')}`);
if (archive.unsafe.length) console.log(`небезопасные члены: ${archive.unsafe.map((u) => `${u.memberPath} (${u.detail})`).join(', ')}`);
if (archive.corrupt) console.log(`архив прочитан не полностью: ${archive.corrupt}`);

if (archive.blocksJson) {
  const meta = inspectRdwebBlocks(archive.blocksJson);
  if (!meta.ok) console.log(`_blocks.json не разобран: ${meta.error.code} — ${meta.error.message}`);
  else console.log(`схема ${meta.value.schemaVersion}, страниц ${meta.value.pages}, блоков ${meta.value.blocks}, типы: ${JSON.stringify(meta.value.blockTypes)}`);
}

// Полный разбор без записи: ожидание SHA берём из самого архива, потому что редакции здесь нет.
// Число страниц считается по самому PDF архива — это и есть база полноты (R04-03).
if (archive.pdf && archive.blocksJson && archive.resultsMd) {
  const pdfPageCount = await pdfPageCountOfBytes(pdfs.get(archive.pdf.memberPath)!.bytes);
  console.log(`страниц в PDF: ${pdfPageCount}`);
  const result = importRdwebExport({ archive, expect: { pdfSha256: archive.pdf.sha256, pdfPageCount } });
  if (!result.ok) {
    console.log(`разбор отклонён: ${result.error.code} — ${result.error.message}`);
  } else {
    const v = result.value;
    console.log(`разбор: ${v.status}, распознано ${v.pagesRecognized} из ${v.pagesTotal}, фрагментов ${v.fragments.length}`);
    console.log(`счётчики: ${JSON.stringify(v.counts)}`);
    for (const w of v.warnings) console.log(`предупреждение ${w.code} ×${w.count}: ${w.sample}`);
  }
}
