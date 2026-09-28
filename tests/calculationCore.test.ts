// Этап 06: правила ядра расчёта — точная десятичная запись без float (ADR-005 §1–2), каноническая
// строка содержимого и её хэш (data-model §5, R01-04), production gate (state-machines §11.1).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lexemeOf, NumLex, parseJsonWithLexemes } from '../packages/adapters/src/index.ts';
import {
  CALCULATION_NORMALIZATION_VERSION,
  calculationContentHash,
  calculationProductionBlockers,
  canonicalDecimal,
  isDecimalLexeme,
  storableText,
  type ICalcContent,
} from '../packages/core/src/index.ts';
import { ADMIN_URL } from './helpers.ts';

let admin: pg.Client;
beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
});
afterAll(async () => admin.end());

const LEXEMES = [
  '0',
  '-0',
  '-0.000',
  '100',
  '1.0',
  '1234.500',
  '0.1',
  '0.000001234',
  '1e+21',
  '1E-7',
  '-2.5e3',
  '12345678901234567890',
  '123456789012345.678901',
  '0.1000000000000000055511151231257827',
  '9007199254740993',
  '-123.4560e-2',
];

describe('каноническая десятичная запись = trim_scale(numeric)::text PostgreSQL', () => {
  it('совпадает с PostgreSQL на экспонентах, нулях, хвостах и 15+ значащих цифрах', async () => {
    for (const lexeme of LEXEMES) {
      const r = await admin.query<{ t: string }>('SELECT trim_scale($1::numeric)::text AS t', [lexeme]);
      expect(canonicalDecimal(lexeme), lexeme).toBe(r.rows[0]!.t);
    }
  });

  it('не десятичные и чрезмерные лексемы отклоняются', () => {
    for (const bad of ['', '01', '1.', '.5', '+1', 'NaN', 'Infinity', '1e999999', '0x10', ' 1', '1 ']) expect(isDecimalLexeme(bad), bad).toBe(false);
    expect(() => canonicalDecimal('1e999999')).toThrow();
  });
});

describe('разбор JSON без промежуточного float (ADR-005 §2)', () => {
  it('каждое число становится лексемой источника, строки и логические — как есть', () => {
    const v = parseJsonWithLexemes('{"a":123456789012345.678901,"b":[1e-7,-0,9007199254740993],"s":"12.5","t":true,"z":null}') as Record<string, unknown>;
    expect(v.a).toBeInstanceOf(NumLex);
    expect(lexemeOf(v.a)).toBe('123456789012345.678901');
    expect((v.b as NumLex[]).map((x) => x.lexeme)).toEqual(['1e-7', '-0', '9007199254740993']);
    // Десятичная строка тоже число контракта (часть полей Go может отдавать строкой).
    expect(lexemeOf(v.s)).toBe('12.5');
    expect(lexemeOf(v.t)).toBeNull();
    expect(v.z).toBeNull();
  });

  it('не JSON — CONTRACT_MISMATCH non_json_response', () => {
    expect(() => parseJsonWithLexemes('<html>Bad Gateway</html>')).toThrow(/не JSON/u);
  });
});

const content = (over: Partial<ICalcContent['header']> = {}, lineOver: Partial<ICalcContent['lines'][number]> = {}): ICalcContent => ({
  header: {
    normalizationVersion: CALCULATION_NORMALIZATION_VERSION,
    sourceGrandTotal: '100',
    usdRate: '90.5',
    eurRate: null,
    cnyRate: null,
    kpTotal: null,
    kpTotalCurrency: null,
    kpTotalRule: null,
    ...over,
  },
  positions: [
    {
      externalPositionId: '00000000-0000-4000-8000-000000000001',
      positionNumber: '1',
      itemNo: '1',
      workName: 'Работа',
      unitCode: 'м3',
      volume: '2',
      manualVolume: null,
      manualNote: null,
      clientNote: null,
      sectionNumber: null,
      positionName: null,
      isSection: false,
      isAdditional: null,
      hierarchyLevel: 1,
      parentExternalPositionId: null,
      costCategoryName: null,
      totalMaterial: null,
      totalWorks: null,
      materialCostPerUnit: null,
      workCostPerUnit: null,
      totalCommercialMaterial: null,
      totalCommercialWork: null,
      totalCommercialMaterialPerUnit: null,
      totalCommercialWorkPerUnit: null,
      baseTotal: '100',
      commercialTotal: '100',
      materialCostTotal: null,
      workCostTotal: null,
      markupPercentage: null,
      itemsCount: 1,
      rawLexemes: {},
    },
  ],
  lines: [
    {
      externalItemId: '00000000-0000-4000-8000-00000000000a',
      externalPositionId: '00000000-0000-4000-8000-000000000001',
      sortNumber: 1,
      itemType: 'раб',
      materialType: null,
      description: null,
      workName: null,
      materialName: null,
      unitCode: 'м3',
      quantity: '2',
      baseQuantity: null,
      consumptionCoefficient: null,
      conversionCoefficient: null,
      unitRate: '50',
      currency: 'RUB',
      deliveryPriceType: null,
      deliveryAmount: null,
      totalAmount: '100',
      commercialMarkup: null,
      totalCommercialMaterial: null,
      totalCommercialWork: '100',
      quoteLink: null,
      costCategory: null,
      detailCostCategory: null,
      detailCostLocation: null,
      workNameId: null,
      materialNameId: null,
      detailCostCategoryId: null,
      parentWorkExternalItemId: null,
      rawLexemes: { unit_rate: '50.00' },
      ...lineOver,
    },
  ],
});

describe('хэш содержимого (R01-04)', () => {
  it('курсы, итог источника, строки и правило итога меняют хэш; исходные лексемы и порядок строк — нет', () => {
    const h = calculationContentHash(content());
    expect(calculationContentHash(content({ usdRate: '91' }))).not.toBe(h);
    expect(calculationContentHash(content({ sourceGrandTotal: '101' }))).not.toBe(h);
    expect(calculationContentHash(content({}, { description: 'иначе' }))).not.toBe(h);
    expect(calculationContentHash(content({ kpTotal: '100', kpTotalCurrency: 'RUB', kpTotalRule: 'rule-x' }))).not.toBe(h);
    // Та же величина, другая запись лексемы — то же содержимое (сравнивается значение, не текст).
    expect(calculationContentHash(content({}, { rawLexemes: { unit_rate: '5e1' } }))).toBe(h);
  });

  it('текст для хранения: одиночный суррогат и NUL заменяются U+FFFD — PostgreSQL их не хранит', () => {
    expect(storableText('a\uD800b\u0000c')).toBe('a�b�c');
  });
});

describe('production gate (state-machines §11.1, ADR-007 §5)', () => {
  it('provisional даёт неотключаемый CALCULATION_PROVISIONAL; verified — нет', () => {
    expect(calculationProductionBlockers('provisional')).toEqual(['CALCULATION_PROVISIONAL']);
    expect(calculationProductionBlockers('verified')).toEqual([]);
  });
});
