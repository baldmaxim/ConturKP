import { describe, expect, it } from 'vitest';
import { factValue, documentCoverage, documentQuality } from '../apps/web/src/utils/factPresentation.ts';


describe('compact contract fact presentation', () => {
  it('groups monetary values with two decimals without editing the source', () => {
    const f = { type: 'estimate_total', display: '243999619.91 RUB', normalized: { amount: 243999619.91, currency: 'RUB' } };
    expect(factValue(f)).toBe('243 999 619,91 ₽');
    expect(f.display).toBe('243999619.91 RUB');
  });
  it('retains exact large decimal strings and does not invent a currency', () => {
    expect(factValue({ type: 'contract_price', display: '', normalized: { amount: '12345678901234567890.55', currency: '' } })).toBe('12 345 678 901 234 567 890,55');
    expect(factValue({ type: 'estimate_total', display: '1000 USD' })).toBe('1 000,00 $');
  });
  it('leaves percentages, dates, organization names and ambiguous text alone', () => {
    for (const [type, display] of [['vat_rate', '20 %'], ['work_end_date', '2026-12-31'], ['party_customer', 'ООО «123456»'], ['estimate_total', 'сумма не установлена']]) expect(factValue({ type, display })).toBe(display);
  });
  it('does not mistake an OCR attempt or confidence for accepted page coverage', () => {
    const doc = { latestRevision: { runStatus: 'complete' }, recognition: { runId: 'preferred', status: 'partial', pagesTotal: 30, pagesRecognized: 12 } };
    expect(documentQuality(doc)).toBe('review');
    expect(documentCoverage(doc)).toEqual({ recognized: 12, total: 30, percent: 40 });
  });
  it('does not show 100% when page counts are missing or inconsistent', () => {
    for (const [pagesTotal, pagesRecognized] of [[null, 0], [0, 0], [10, 11], [10, null]]) {
      expect(documentCoverage({ recognition: { pagesTotal, pagesRecognized } })).toBeNull();
    }
  });
  it('distinguishes not yet processed, queued and failed files', () => {
    for (const [runStatus, result] of [[null, 'unread'], ['queued', 'pending'], ['running', 'pending'], ['failed', 'unread'], ['complete', 'complete']]) {
      expect(documentQuality({ latestRevision: { runStatus } })).toBe(result);
    }
  });
});
