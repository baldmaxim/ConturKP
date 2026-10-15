// Корпус профиля нагрузки D-040 для замеров (scripts/ops/measure-corpus.ts): план по объёму, детерминированный
// уникальный текст страниц, экспорт RDWeb разбирается тем же адаптером, что у worker, а PDF имеет столько страниц,
// сколько объявлено, — иначе замер профиля «до 1 ГБ Markdown» мерил бы неполные прогоны.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { importRdwebExport } from '../packages/adapters/src/index.ts';
import { pdfPageCountOfBytes } from '../apps/worker/src/pdfPages.ts';
import { mdCorpusPlan, mdExportParts, pageText } from '../scripts/ops/measure-corpus.ts';

describe('корпус профиля D-040 для замеров', () => {
  it('план: объём делится на документы, страниц в документе не больше предела разбора', () => {
    const small = mdCorpusPlan({ totalMb: 20, docMb: 5, pageKb: 3 });
    expect(small).toHaveLength(4);
    expect(small.reduce((a, d) => a + d.pages, 0)).toBe(Math.round((20 * 1024) / 3));
    const full = mdCorpusPlan({ totalMb: 1024, docMb: 5, pageKb: 3 });
    expect(full.reduce((a, d) => a + d.pages, 0)).toBe(Math.round((1024 * 1024) / 3));
    expect(full.every((d) => d.pages <= 9000)).toBe(true);
    expect(new Set(full.map((d) => d.name)).size).toBe(full.length);
  });

  it('текст страницы: детерминирован, уникален по странице, около заданного объёма', () => {
    expect(pageText(1, 0, 3)).toBe(pageText(1, 0, 3));
    expect(pageText(1, 0, 3)).not.toBe(pageText(1, 1, 3));
    expect(pageText(1, 0, 3)).not.toBe(pageText(2, 0, 3));
    const bytes = Buffer.byteLength(pageText(7, 5, 3), 'utf8');
    expect(bytes).toBeGreaterThanOrEqual(3 * 1024);
    expect(bytes).toBeLessThan(3 * 1024 + 400);
  });

  it('экспорт разбирается адаптером RDWeb полностью, PDF содержит объявленные страницы', async () => {
    const doc = { index: 1, name: 'MD-Том-0001', pages: 30 };
    const parts = mdExportParts(doc, 3);
    expect(await pdfPageCountOfBytes(new Uint8Array(parts.pdf))).toBe(30);
    const pdfSha256 = createHash('sha256').update(parts.pdf).digest('hex');
    const r = importRdwebExport({
      archive: {
        pdf: { memberPath: `${doc.name}.pdf`, sha256: pdfSha256 },
        blocksJson: parts.blocksJson,
        resultsMd: parts.resultsMd,
        resultsHtmlPresent: true,
        extras: [],
        ignored: [],
        unsafe: [],
        corrupt: null,
        groupMismatch: null,
        groupAmbiguous: null,
      },
      expect: { pdfSha256, pdfPageCount: 30 },
    });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    expect(r.value.status).toBe('complete');
    expect(r.value.pagesRecognized).toBe(30);
    const text = r.value.fragments.map((f) => f.text).join('\n');
    expect(text).toContain('П. 1.1.1.');
    expect(text.length).toBeGreaterThan(30 * 3 * 1024 * 0.4);
  });
});
