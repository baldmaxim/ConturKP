// Генерирует иконки приложения из public/kontur-kp-favicon.svg (BRAND.md §12.4).
// Запуск: npm run icons:generate -w @kontur/web
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SOURCE_FILE = 'kontur-kp-favicon.svg';
const SOURCE_VIEWBOX = 'viewBox="0 0 512 512"';
const TAB_VIEWBOX = 'viewBox="56 56 400 400"';
const SOURCE_SIZE = 512;
const BACKGROUND = '#0F5B6E'; // = background_color в manifest.json

const PNG_TARGETS = [
  { file: 'favicon-32.png', size: 32 },
  { file: 'apple-touch-icon-120.png', size: 120 },
  { file: 'apple-touch-icon-152.png', size: 152 },
  { file: 'apple-touch-icon-167.png', size: 167 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-512-maskable.png', size: 512 },
];

const MANIFEST = {
  name: 'Контур КП',
  short_name: 'Контур КП',
  description: 'От исходных данных до согласованного предложения',
  lang: 'ru',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: BACKGROUND,
  theme_color: BACKGROUND,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
};

const svg = await readFile(join(publicDir, SOURCE_FILE), 'utf8');
if (!svg.includes(SOURCE_VIEWBOX)) {
  throw new Error(`${SOURCE_FILE}: ожидался ${SOURCE_VIEWBOX}`);
}

// Вкладка браузера: тот же рисунок, поля плитки обрезаны — на размере 16 px силуэт листа крупнее.
await writeFile(join(publicDir, 'favicon.svg'), svg.replace(SOURCE_VIEWBOX, TAB_VIEWBOX));
console.log('✓ favicon.svg');

for (const { file, size } of PNG_TARGETS) {
  const density = Math.ceil((size * 72) / SOURCE_SIZE) * 4; // растеризация с запасом ×4
  const output = join(publicDir, file);
  await sharp(Buffer.from(svg), { density })
    .resize(size, size)
    .flatten({ background: BACKGROUND })
    .png({ compressionLevel: 9 })
    .toFile(output);
  const { width, height, hasAlpha } = await sharp(output).metadata();
  if (width !== size || height !== size || hasAlpha) {
    throw new Error(`${file}: получено ${width}×${height}, alpha=${hasAlpha}`);
  }
  console.log(`✓ ${file} ${size}×${size}`);
}

// Манифест генерируется здесь же, чтобы список иконок и цвет фона не расходились с PNG.
await writeFile(join(publicDir, 'manifest.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
console.log('✓ manifest.json');
