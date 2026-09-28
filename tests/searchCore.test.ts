// Чистые правила поиска (packages/core/src/search.ts): нормализация запроса, обозначения точной
// ветки, нарезка страницы на чанки, RRF, хэши области и шаблон входа модели. Без БД.
import { describe, expect, it } from 'vitest';
import {
  buildPageChunks,
  chunkKeyOf,
  chunkText,
  designationTokens,
  embeddingInput,
  embeddingInputVersion,
  emptyScopeMessage,
  evidenceScopeContentHash,
  exactFold,
  expandRetrievalQuery,
  fuseRrf,
  normalizeQuery,
  probeMatches,
  searchScopeHash,
  templateOfInputVersion,
} from '../packages/core/src/index.ts';

const f = (id: string, text: string, kind = 'text_block', origin = 'recognized_text') => ({ id, text, kind, origin });

describe('запрос и обозначения', () => {
  it('нормализация: NFC, пробелы, обрезка', () => {
    expect(normalizeQuery('  Какой\n\tаванс   по  договору? ')).toBe('Какой аванс по договору?');
    expect(normalizeQuery('е́').length).toBe(normalizeQuery('е́').normalize('NFC').length);
  });

  it('обозначения: коды, пункты, величины, шифры; короткие числа и обычные слова — нет', () => {
    expect(designationTokens('лист АР-01, бетон B30, п. 3.1, неустойка 0,1%, год 2026, срок 30 дней, шифр ФИКС-АР, марка КЖ')).toEqual(
      ['0,1%', '2026', '3.1', 'ар-01', 'в30', 'фикс-ар'].map(exactFold).sort(),
    );
    expect(designationTokens('«Опорный узел»')).toEqual(['опорный узел']);
    expect(designationTokens('какой аванс по договору')).toEqual([]);
  });

  it('обзорный вопрос по договору расширяется договорными терминами (правило донора Locus); конкретный — нет', () => {
    const overview = expandRetrievalQuery('Какие основные условия договора по Стромынке?');
    expect(overview.expanded).toBe(true);
    expect(overview.text).toContain('ответственность штраф пени неустойка');
    expect(expandRetrievalQuery('Какой размер гарантийного удержания?')).toEqual({ text: 'Какой размер гарантийного удержания?', expanded: false });
    // Обзорное намерение без договорного контекста не расширяется.
    expect(expandRetrievalQuery('основные риски проекта').expanded).toBe(false);
  });

  it('свёртка латинских двойников: «B30» и «В30» совпадают', () => {
    expect(exactFold('B30')).toBe(exactFold('В30'));
    expect(exactFold('KЖ-1')).toBe(exactFold('КЖ-1'));
    expect(exactFold('Ёмкость')).toBe('емкость');
  });
});

describe('нарезка страницы (ADR-012 §1–2)', () => {
  it('шапка из штампов повторяется в каждой части; описание модели и пустой текст не индексируются', () => {
    const r = buildPageChunks(
      [
        f('s1', 'Шифр АР-01 Лист 3', 'stamp_block'),
        f('b1', 'а'.repeat(100)),
        f('m1', 'описание картинки', 'summary', 'model_description'),
        f('h1', 'подсказка', 'text_block', 'negotiation_hint'),
        f('e1', '   '),
        f('b2', 'б'.repeat(100)),
      ],
      { maxBodyChars: 150, maxHeaderChars: 100, overlapChars: 50 },
    );
    expect(r.chunks).toHaveLength(2);
    for (const c of r.chunks) {
      expect(c.headerText).toBe('Шифр АР-01 Лист 3');
      expect(c.links[0]).toMatchObject({ fragmentId: 's1', role: 'header', charStart: 0, charEnd: 17 });
    }
    expect(r.skipped).toEqual([
      { fragmentId: 'm1', reason: 'origin_not_evidence' },
      { fragmentId: 'h1', reason: 'origin_not_evidence' },
      { fragmentId: 'e1', reason: 'empty_text' },
    ]);
    expect(r.indexed.sort()).toEqual(['b1', 'b2', 's1']);
  });

  it('смещения фрагментов указывают на их текст в тексте чанка', () => {
    const r = buildPageChunks([f('s', 'Шапка', 'stamp_block'), f('x', 'Первый абзац'), f('y', 'Второй абзац')]);
    const c = r.chunks[0]!;
    const text = chunkText(c);
    for (const l of c.links) {
      const src = { s: 'Шапка', x: 'Первый абзац', y: 'Второй абзац' }[l.fragmentId as 's' | 'x' | 'y'];
      expect(text.slice(l.charStart, l.charEnd)).toBe(src);
    }
  });

  it('длинная страница: короткий фрагмент на стыке повторяется в следующей части (перекрытие)', () => {
    const r = buildPageChunks([f('a', 'а'.repeat(120)), f('joint', 'стык'), f('c', 'в'.repeat(120))], { maxBodyChars: 130, maxHeaderChars: 100, overlapChars: 10 });
    expect(r.chunks.map((c) => c.links.map((l) => l.fragmentId))).toEqual([['a', 'joint'], ['joint', 'c']]);
  });

  it('страница без доказательного текста чанков не даёт; ключ чанка детерминирован', () => {
    expect(buildPageChunks([f('m', 'описание', 'summary', 'model_description')]).chunks).toEqual([]);
    expect(chunkKeyOf('run', 3, 1)).toBe('run:p3:c1');
    expect(chunkKeyOf('run', null, 0)).toBe('run:px:c0');
  });
});

describe('RRF (ADR-012 §11)', () => {
  const hit = (id: string) => ({ fragmentId: id, origin: 'recognized_text', chunkKey: null, score: 1 });
  it('сумма 1/(k+ранг) по веткам; фрагмент из двух веток выше; ничьи — детерминированно', () => {
    const fused = fuseRrf({ exact: [hit('x')], fts: [hit('y'), hit('x')], vector: [hit('z')] }, 10);
    expect(fused.map((h) => h.fragmentId)).toEqual(['x', 'y', 'z']);
    expect(fused[0]!.matchedVia).toEqual(['exact', 'fts']);
    const again = fuseRrf({ fts: [hit('b'), hit('a')], vector: [hit('a'), hit('b')] }, 10);
    expect(again.map((h) => h.fragmentId)).toEqual(['a', 'b']);
    expect(fuseRrf({ fts: [hit('x'), hit('y')] }, 1)).toHaveLength(1);
  });

  it('фрагмент, повторённый в одной ветке, учитывается один раз', () => {
    const fused = fuseRrf({ fts: [hit('x'), hit('x')] }, 10);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.score).toBeCloseTo(1 / 61);
  });
});

describe('хэши области и модель', () => {
  it('хэш снимка не зависит от порядка единиц; хэш области — от порядка ID', () => {
    const u1 = { unitType: 'document_recognition' as const, documentRevisionId: 'r1', recognitionRunId: 'run1' };
    const u2 = { unitType: 'document_recognition' as const, documentRevisionId: 'r2', recognitionRunId: null };
    expect(evidenceScopeContentHash('h', [u1, u2])).toBe(evidenceScopeContentHash('h', [u2, u1]));
    expect(evidenceScopeContentHash('h', [u1])).not.toBe(evidenceScopeContentHash('h', [u2]));
    expect(searchScopeHash('s', ['b', 'a'])).toBe(searchScopeHash('s', ['a', 'b']));
  });

  it('шаблон входа e5 — префиксы query/passage и версия шаблона', () => {
    expect(embeddingInput('e5', 'query', 'аванс')).toBe('query: аванс');
    expect(embeddingInput('e5', 'index', 'аванс')).toBe('passage: аванс');
    expect(embeddingInput('plain', 'query', 'аванс')).toBe('аванс');
    expect(templateOfInputVersion(embeddingInputVersion('e5'))).toBe('e5');
    expect(templateOfInputVersion(embeddingInputVersion('plain'))).toBe('plain');
  });

  it('пробный вектор: совпадение по косинусу, подмена весов замечается', () => {
    expect(probeMatches([1, 0, 0], [0.9999, 0.001, 0])).toBe(true);
    expect(probeMatches([1, 0, 0], [0.8, 0.6, 0])).toBe(false);
  });

  it('пустой результат формулируется охватом области', () => {
    expect(emptyScopeMessage(1, 1, 2)).toBe('не найдено в области: 1 единица, 1 страница распознано из 2');
    expect(emptyScopeMessage(5, 11, 12)).toBe('не найдено в области: 5 единиц, 11 страниц распознано из 12');
  });
});
