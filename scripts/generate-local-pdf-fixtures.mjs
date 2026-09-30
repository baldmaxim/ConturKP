// Генератор PDF-фикстур этапа 05a (tests/fixtures/local/*.pdf). PDF печатает Chromium без песочницы
// (CHROME_PATH), растр скана — Chromium со screenshot, порча скана — @napi-rs/canvas с детерминированным
// шумом. Байты PDF Chromium не детерминированы (дата создания, идентификатор), поэтому файлы
// генерируются один раз и хранятся в репозитории; их SHA-256 — в отчёте этапа.
// Запуск: CHROME_PATH=… node scripts/generate-local-pdf-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('нужен CHROME_PATH');
const out = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'local');
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'kontur-pdf-fx-'));

const LETTER = [
  'ООО «СтройМонолит». Исх. № 214 от 26.06.2026.',
  'Генеральному директору ООО «Стромынка Девелопмент».',
  'Объект: жилой комплекс, ул. Стромынка, вл. 5, договор строительного подряда № 15-П от 10.02.2026.',
  'Настоящим сообщаем, что по состоянию на 25.06.2026 Заказчиком не переданы разделы рабочей документации КЖ и ОВ. ' +
    'В связи с этим Генподрядчик приостанавливает работы с 01.07.2026 до получения документации.',
  'Concrete class B30 W8 F150, reinforcement A500C d12–d32. Total: 244 800 000 RUB.',
];

const page = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:0}body{margin:0;font-family:'DejaVu Serif';font-size:17px;color:#111}` +
  `.p{width:794px;height:1123px;box-sizing:border-box;padding:70px 80px;line-height:1.5;page-break-after:always;background:#fff}` +
  `img{width:210mm;height:297mm;display:block;page-break-after:always}</style></head><body>${body}</body></html>`;
const letterHtml = `<div class="p">${LETTER.map((l) => `<p>${l}</p>`).join('')}</div>`;

const chromeRun = (args) => execFileSync(chrome, ['--no-sandbox', '--headless', '--disable-gpu', '--hide-scrollbars', ...args], { stdio: 'ignore' });
const html = (name, body) => {
  const p = join(tmp, `${name}.html`);
  writeFileSync(p, page(body));
  return `file://${p}`;
};
const printPdf = (name, body) => {
  const target = join(out, `${name}.pdf`);
  chromeRun(['--no-pdf-header-footer', `--print-to-pdf=${target}`, html(name, body)]);
  return target;
};
const screenshot = (name, body) => {
  const target = join(tmp, `${name}.png`);
  chromeRun(['--force-device-scale-factor=3.125', '--window-size=794,1123', `--screenshot=${target}`, html(name, body)]);
  return target;
};

// Детерминированный генератор (mulberry32): одинаковая порча при каждом запуске.
const rng = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const degrade = async (src, target, { angle, scale, contrast, speckles, seed }) => {
  const img = await loadImage(readFileSync(src));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(0, 0, c.width, c.height);
  // Размытие — уменьшением и обратным увеличением растра.
  const small = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
  small.getContext('2d').drawImage(img, 0, 0, small.width, small.height);
  ctx.save();
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.globalAlpha = contrast;
  ctx.drawImage(small, -c.width / 2, -c.height / 2, c.width, c.height);
  ctx.restore();
  const r = rng(seed);
  ctx.globalAlpha = 1;
  for (let i = 0; i < speckles; i += 1) {
    const g = Math.floor(r() * 120);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(Math.floor(r() * c.width), Math.floor(r() * c.height), 1 + Math.floor(r() * 4), 1 + Math.floor(r() * 4));
  }
  writeFileSync(target, c.toBuffer('image/png'));
};

const noiseImage = (target, seed) => {
  const c = createCanvas(2481, 3509);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  const r = rng(seed);
  for (let i = 0; i < 60000; i += 1) {
    const g = Math.floor(r() * 256);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(Math.floor(r() * c.width), Math.floor(r() * c.height), 2 + Math.floor(r() * 18), 2 + Math.floor(r() * 18));
  }
  writeFileSync(target, c.toBuffer('image/png'));
};

try {
  const scan = screenshot('scan', letterHtml);
  printPdf('letter-text', letterHtml);
  printPdf('letter-scan', `<img src="file://${scan}">`);
  printPdf('mixed', `${letterHtml}<img src="file://${scan}">`);
  printPdf('blank', '<div class="p"></div>');
  const soft = join(tmp, 'scan-soft.png');
  await degrade(scan, soft, { angle: 1.2, scale: 0.55, contrast: 0.75, speckles: 4000, seed: 7 });
  printPdf('letter-scan-soft', `<img src="file://${soft}">`);
  const hard = join(tmp, 'scan-hard.png');
  await degrade(scan, hard, { angle: 2.5, scale: 0.28, contrast: 0.4, speckles: 40000, seed: 11 });
  printPdf('letter-scan-hard', `<img src="file://${hard}">`);
  const noise = join(tmp, 'noise.png');
  noiseImage(noise, 3);
  printPdf('noise', `<img src="file://${noise}">`);
  for (const n of ['letter-text', 'letter-scan', 'mixed', 'blank', 'letter-scan-soft', 'letter-scan-hard', 'noise']) {
    const bytes = readFileSync(join(out, `${n}.pdf`));
    console.log(`${n}.pdf ${bytes.length} ${createHash('sha256').update(bytes).digest('hex')}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
