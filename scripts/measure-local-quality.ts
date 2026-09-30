// Замер метрик качества на корпусе фикстур (OD-6, D-024): числа шлюза фиксируются только после
// показа распределения. Корпус — фикстуры 05a (PDF: текстовый слой, чистый, смягчённый и жёстко
// испорченный скан, смешанный, пустой, шум) и фикстуры Locus product-v2 (договоры, допсоглашение,
// смета — «выход конвертера», скан письма — «выход OCR»). Вывод — таблица в stdout.
// Запуск: node scripts/measure-local-quality.ts [DPI]
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTesseractJsFactory, nativeLayerUsable, ocrPageStatus, textMetrics } from '@kontur/adapters';
import { prepareTesseractModels } from '@kontur/storage';
import { nativeBlocks, openPdf, renderPagePng } from '../packages/adapters/src/local/pdf.ts';

const root = resolve(import.meta.dirname, '..');
const dpi = Number(process.argv[2] ?? 300);
const rows: string[] = [];
const line = (cols: (string | number | null)[]): void => {
  rows.push(cols.map((c) => String(c ?? '—')).join('\t'));
};

line(['источник', 'единица', 'способ', 'символов', 'слов', 'доля букв', 'доля U+FFFD', 'доля шума', 'шумных', 'уверенность OCR', 'мс', 'по шлюзу']);

const locus = join(root, 'tests', 'fixtures', 'locus-product-v2');
for (const project of readdirSync(locus, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const file of readdirSync(join(locus, project.name)).filter((f) => f.endsWith('.md')).sort()) {
    const text = readFileSync(join(locus, project.name, file), 'utf8');
    // Разделы «## …» — страницы выхода конвертера или OCR донора.
    const parts = text.split(/\n(?=## )/).filter((p) => p.startsWith('## '));
    for (const part of parts.length > 0 ? parts : [text]) {
      const m = textMetrics(part.replace(/^## .*\n/, ''));
      line([`locus/${project.name}/${file}`, part.split('\n')[0]!.slice(3, 40), file.includes('skan') ? 'ocr-донор' : 'текст-донор', m.chars, m.words, m.letterRatio, m.replacementRatio, m.noiseRatio, m.noisyTokens, null, null, nativeLayerUsable(m).usable ? 'пригоден' : nativeLayerUsable(m).issues.join(',')]);
    }
  }
}

const engine = await createTesseractJsFactory(prepareTesseractModels).create();
try {
  const dir = join(root, 'tests', 'fixtures', 'local');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort()) {
    const doc = await openPdf(new Uint8Array(readFileSync(join(dir, file))));
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const native = textMetrics((await nativeBlocks(page)).join('\n'));
      const nu = nativeLayerUsable(native);
      line([`05a/${file}`, `стр. ${n}`, 'текстовый слой', native.chars, native.words, native.letterRatio, native.replacementRatio, native.noiseRatio, native.noisyTokens, null, null, nu.usable ? 'пригоден' : nu.issues.join(',')]);
      const t0 = Date.now();
      const res = await engine.recognize(await renderPagePng(page, dpi));
      const m = textMetrics(res.blocks.map((b: { text: string }) => b.text).join('\n'));
      const st = ocrPageStatus(m, res.confidence);
      line([`05a/${file}`, `стр. ${n}`, `OCR ${dpi} dpi`, m.chars, m.words, m.letterRatio, m.replacementRatio, m.noiseRatio, m.noisyTokens, res.confidence, Date.now() - t0, [st.status, ...st.issues].join(',')]);
      page.cleanup();
    }
    await doc.destroy();
  }
} finally {
  await engine.close();
}
console.log(rows.join('\n'));
