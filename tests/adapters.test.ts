// Чистый разбор экспорта RDWeb: без БД, без сети, без файловой системы. Проверяется то,
// что решает адаптер: полнота (A16), координаты и поворот (A17), разделение происхождения
// текста (I06), отказ от чужого результата и от чужой схемы, неприкосновенность crop_url (A38).
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importRdwebExport, inspectRdwebBlocks, sheetLabelOf, type IRdwebArchive } from '../packages/adapters/src/index.ts';
import { buildRdwebExport, type IRdwebFixture } from './rdweb.ts';

const archiveOf = (o: IRdwebFixture = {}, patch: Partial<IRdwebArchive> = {}) => {
  const fx = buildRdwebExport(o);
  const archive: IRdwebArchive = {
    pdf: { memberPath: `${fx.expected.docName}.pdf`, sha256: fx.expected.pdfSha256 },
    blocksJson: fx.blocksJson,
    resultsMd: fx.resultsMd,
    resultsHtmlPresent: true,
    extras: [],
    ignored: [],
    unsafe: [],
    corrupt: null,
    ...patch,
  };
  // Число страниц оригинала — вход разбора: адаптер сам PDF не читает (R04-03).
  return {
    fx,
    archive,
    run: (pdfPageCount = fx.expected.pagesTotal) => importRdwebExport({ archive, expect: { pdfSha256: fx.expected.pdfSha256, pdfPageCount } }),
  };
};

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!r.ok) throw new Error(`ожидался успех, получен отказ ${r.error.code}: ${r.error.message}`);
  return r.value;
};

describe('адаптер RDWeb: разбор экспорта', () => {
  it('полный архив: страницы, блоки и производные поля разделены по происхождению', () => {
    const { fx, run } = archiveOf();
    const v = ok(run());
    expect(v.status).toBe('complete');
    expect(v.pagesTotal).toBe(4);
    expect(v.pagesRecognized).toBe(4);
    expect(v.schemaVersion).toBe('1');
    expect(v.pages.map((p) => p.pageLabel)).toEqual(['1', '2', '3', '4']);

    const byKind = (k: string) => v.fragments.filter((f) => f.fragmentKind === k);
    expect(byKind('text_block')).toHaveLength(fx.expected.textBlockIds.length);
    expect(byKind('summary')).toHaveLength(fx.expected.imageBlockIds.length);
    expect(byKind('verification')).toHaveLength(fx.expected.imageBlockIds.length);
    // Распознанный текст и описание модели — разные происхождения, не смешиваются (I06).
    expect(byKind('text_block').every((f) => f.origin === 'recognized_text')).toBe(true);
    expect(byKind('summary').every((f) => f.origin === 'model_description' && f.derivedModelRef === 'rdweb_export:summary')).toBe(true);
    // Описание изображения не попадает в распознанный текст блока.
    expect(v.fragments.filter((f) => f.origin === 'recognized_text').some((f) => f.text.includes('Краткое описание'))).toBe(false);
    expect(v.fragments.every((f) => f.textSha256.length === 64)).toBe(true);
  });

  it('A16: страница без вывода даёт partial и явную пометку missing', () => {
    const v = ok(archiveOf({ pages: 4, omitPagesInMd: [2] }).run());
    expect(v.status).toBe('partial');
    expect(v.pagesRecognized).toBe(3);
    expect(v.pages.find((p) => p.pageIndex === 2)!.status).toBe('missing');
    expect(v.pages.filter((p) => p.status === 'recognized')).toHaveLength(3);
    expect(v.fragments.some((f) => f.pageIndex === 2)).toBe(false);
  });

  it('A17: повёрнутая страница и отсутствующий crop — координаты и поворот сохранены', () => {
    const { fx, run } = archiveOf({ rotate90: [1], cropUrls: 'except-stamps' });
    const v = ok(run());
    const onRotated = v.fragments.filter((f) => f.pageIndex === 1 && f.bboxNorm);
    expect(onRotated.length).toBeGreaterThan(0);
    expect(onRotated.every((f) => f.rotation === 90 && f.bboxSpace === 'page_rotated')).toBe(true);
    expect(onRotated.every((f) => f.bboxNorm!.length === 4 && f.bboxNorm!.every((n) => n >= 0 && n <= 1))).toBe(true);
    expect(v.pages.find((p) => p.pageIndex === 1)).toMatchObject({ rotation: 90, widthPx: 3508, heightPx: 2480 });

    const stamp = v.fragments.find((f) => f.externalBlockId === fx.expected.stampBlockIds[1]);
    expect(stamp, 'штамп повёрнутой страницы привязан к блоку').toBeTruthy();
    expect(stamp!.externalCropUrl).toBeNull();
    const text = v.fragments.find((f) => f.externalBlockId === fx.expected.textBlockIds[1]);
    expect(text!.externalCropUrl).toContain('https://rdweb.example.internal/crops');
  });

  it('штампы: повтор в каждой секции страницы схлопывается, номер листа берётся из штампа', () => {
    const { fx, run } = archiveOf({ pages: 3 });
    const v = ok(run());
    const stampFragments = v.fragments.filter((f) => f.fragmentKind === 'stamp_block');
    expect(stampFragments).toHaveLength(3);
    expect(stampFragments.map((f) => f.externalBlockId).sort()).toEqual([...fx.expected.stampBlockIds].sort());
    // Номер листа — из штампа, а не из номера страницы файла (discovery §7.1).
    expect(v.pages.map((p) => p.sheetLabel)).toEqual(['1 из 3', '2 из 3', '3 из 3']);
    expect(v.pages.map((p) => p.pageLabel)).toEqual(['1', '2', '3']);
  });

  it('неизвестный тип блока импортируется с пометкой, а не отбрасывается', () => {
    const { fx, run } = archiveOf({ unknownBlockTypes: ['table'] });
    const v = ok(run());
    const unknown = v.fragments.find((f) => f.externalBlockId === fx.expected.unknownBlockIds[0]);
    expect(unknown).toBeTruthy();
    expect(unknown!.fragmentKind).toBe('unknown_block');
    expect(unknown!.warnings).toContain('unknown_block_type');
    expect(v.warnings.find((w) => w.code === 'unknown_block_type')?.sample).toBe('table');
  });

  it('polygon сохраняется вместе с прямоугольной рамкой', () => {
    const { fx, run } = archiveOf({ polygonPages: [0] });
    const v = ok(run());
    const f = v.fragments.find((x) => x.externalBlockId === fx.expected.textBlockIds[0])!;
    expect(f.shapeType).toBe('polygon');
    expect(f.polygonNorm).toEqual([0.1, 0.1, 0.9, 0.1, 0.9, 0.3, 0.1, 0.3]);
    expect(f.bboxNorm).toHaveLength(4);
  });

  it('чужой или старый результат не принимается', () => {
    const fx = buildRdwebExport();
    const other = buildRdwebExport({ docName: 'Другой' });
    const r = importRdwebExport({
      archive: {
        pdf: { memberPath: 'x.pdf', sha256: other.expected.pdfSha256 },
        blocksJson: fx.blocksJson,
        resultsMd: fx.resultsMd,
        resultsHtmlPresent: true,
        extras: [],
        ignored: [],
        unsafe: [],
        corrupt: null,
      },
      expect: { pdfSha256: fx.expected.pdfSha256, pdfPageCount: fx.expected.pagesTotal },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('pdf_mismatch');
  });

  it('отказы формата: отсутствующие члены, битый JSON, чужая схема и пространство координат', () => {
    const cases: [Partial<IRdwebArchive> | IRdwebFixture, string, boolean][] = [
      [{ pdf: null }, 'pdf_missing', true],
      [{ blocksJson: null }, 'blocks_json_missing', true],
      [{ resultsMd: null }, 'results_md_missing', true],
      [{ corrupt: 'каталог архива повреждён' }, 'archive_corrupt', true],
      [{ unsafe: [{ memberPath: '../evil', detail: 'выход за корень' }] }, 'archive_unsafe', true],
      [{ brokenJson: true }, 'blocks_json_invalid', false],
      [{ schemaVersion: 2 }, 'schema_version_unsupported', false],
      [{ coordinateSpace: 'pdf_user_space' }, 'coordinate_space_unsupported', false],
    ];
    for (const [patch, code, isArchivePatch] of cases) {
      const r = isArchivePatch ? archiveOf({}, patch as Partial<IRdwebArchive>).run() : archiveOf(patch as IRdwebFixture).run();
      expect(r.ok, `${code}: ожидался отказ`).toBe(false);
      expect(r.ok === false && r.error.code).toBe(code);
    }
  });

  it('лишние члены архива дают предупреждение, но не отказ', () => {
    const v = ok(archiveOf({}, { extras: ['заметки.txt'], resultsHtmlPresent: false }).run());
    expect(v.status).toBe('complete');
    expect(v.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['unexpected_member', 'results_html_missing']));
  });

  // R04-06: доказательство не усекается. Длинный текст блока сохраняется частями со
  // стабильными ключами, склейка частей возвращает исходный текст целиком.
  it('пределы разбора: превышение объёма — отказ, длинный фрагмент — разбиение без потерь', () => {
    const fx = buildRdwebExport({ hugeTextChars: 5000 });
    const expectOf = { pdfSha256: fx.expected.pdfSha256, pdfPageCount: fx.expected.pagesTotal };
    const archive: IRdwebArchive = {
      pdf: { memberPath: 'x.pdf', sha256: fx.expected.pdfSha256 },
      blocksJson: fx.blocksJson,
      resultsMd: fx.resultsMd,
      resultsHtmlPresent: true,
      extras: [],
      ignored: [],
      unsafe: [],
      corrupt: null,
    };
    const split = ok(importRdwebExport({ archive, expect: expectOf, limits: { maxFragmentChars: 1000 } }));
    const parts = split.fragments.filter((f) => f.warnings.includes('text_split')).sort((a, b) => a.partIndex - b.partIndex);
    expect(parts).toHaveLength(5);
    expect(parts.map((p) => p.partIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(parts.every((p) => p.partTotal === 5)).toBe(true);
    expect(parts.map((p) => p.fragmentKey)).toEqual([1, 2, 3, 4, 5].map((n) => `block:${fx.expected.textBlockIds[0]}:text#p${n}`));
    // Текст восстановим полностью: «успеха с потерянным хвостом» не существует.
    expect(parts.map((p) => p.text).join('')).toBe('я'.repeat(5000));
    expect(split.fragments.some((f) => f.warnings.includes('text_truncated'))).toBe(false);
    // Повторный разбор того же архива даёт те же ключи: они не зависят от числа фрагментов.
    const again = ok(importRdwebExport({ archive, expect: expectOf, limits: { maxFragmentChars: 1000 } }));
    expect(again.fragments.map((f) => f.fragmentKey)).toEqual(split.fragments.map((f) => f.fragmentKey));

    const overflow = importRdwebExport({ archive, expect: expectOf, limits: { maxTotalTextChars: 500 } });
    expect(overflow.ok === false && overflow.error.code).toBe('too_large');

    const tooManyPages = importRdwebExport({ archive, expect: expectOf, limits: { maxPages: 2 } });
    expect(tooManyPages.ok === false && tooManyPages.error.code).toBe('too_large');
  });

  // R04-03: база полноты — сам оригинал, а не состав экспорта.
  it('число страниц берётся у оригинала: экспорт без страницы не даёт complete', () => {
    const a = archiveOf({ pages: 4, omitPagesInBlocks: [3] });
    const v = ok(a.run(4));
    expect(v.pagesTotal).toBe(4);
    expect(v.pagesRecognized).toBe(3);
    expect(v.status).toBe('partial');
    expect(v.pages.map((p) => p.status)).toEqual(['recognized', 'recognized', 'recognized', 'missing']);
    expect(v.warnings.map((w) => w.code)).toContain('blocks_page_count_mismatch');
  });

  it('пустой заголовок страницы распознаванием не считается', () => {
    const a = archiveOf({ pages: 4, emptyMdPages: [3] });
    const v = ok(a.run(4));
    expect(v.pagesTotal).toBe(4);
    expect(v.pages[3]!.status).toBe('missing');
    expect(v.status).toBe('partial');
    expect(v.warnings.map((w) => w.code)).toContain('page_output_empty');
    expect(v.fragments.some((f) => f.pageIndex === 3)).toBe(false);
  });

  it('без достоверного числа страниц оригинала разбор отклоняется', () => {
    const r = archiveOf().run(0);
    expect(r.ok === false && r.error.code).toBe('pdf_unreadable');
  });

  it('inspect даёт счётчики без текста', () => {
    const fx = buildRdwebExport({ pages: 2 });
    const v = ok(inspectRdwebBlocks(fx.blocksJson));
    expect(v).toMatchObject({ schemaVersion: 1, pages: 2 });
    expect(v.blockTypes).toEqual({ text: 2, image: 2, stamp: 2 });
  });

  it('номер листа из штампа: не распознали — null, а не номер страницы', () => {
    expect(sheetLabelOf('Лист 7 из 77 · Шифр')).toBe('7 из 77');
    expect(sheetLabelOf('Шифр АР без номера')).toBeNull();
  });

  it('A38: адаптер не умеет ходить в сеть — в его исходниках нет сетевых вызовов', () => {
    const dir = resolve(import.meta.dirname, '..', 'packages', 'adapters', 'src');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith('.ts')) files.push(join(d, e.name));
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/\bfetch\s*\(/);
      expect(src, f).not.toMatch(/node:(http|https|net|dgram|dns)\b/);
      expect(src, f).not.toMatch(/\bnode:fs\b/);
    }
  });

  it('crop_url опасного вида сохраняется как текст и никем не загружается', () => {
    const { fx, run } = archiveOf({ cropUrls: 'all', cropUrlValue: 'http://127.0.0.1:3000/api/v1/admin/users' });
    const v = ok(run());
    const f = v.fragments.find((x) => x.externalBlockId === fx.expected.textBlockIds[0])!;
    expect(f.externalCropUrl).toBe('http://127.0.0.1:3000/api/v1/admin/users/blk-0-txt.png');
    expect(v.counts.cropUrlsFetched).toBe(0);
  });
});
