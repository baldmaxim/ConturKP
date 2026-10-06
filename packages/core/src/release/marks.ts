// Видимые отметки в документах комплекта (D-032 В-12-8; state-machines §11): тестовый режим и демо-шаблон помечаются
// в самом документе — значит, и в превью. Отметки не снимают блокеров: Q-08 и X-01 автоматически не снимаются.
// Проверка подмены шрифтов (D-032 В-12-2): шрифт, которым набран текст, обязан быть встроен в PDF.

export const TEST_MARK = 'ТЕСТОВЫЙ ВЫПУСК — НЕ ДЛЯ ОТПРАВКИ ЗАКАЗЧИКУ';
export const DEMO_MARK = 'ДЕМОНСТРАЦИОННАЯ ФОРМА — НЕ ДЛЯ ВЫПУСКА';

export const documentMarks = (mode: 'test' | 'production', isDemo: boolean): string[] => [...(mode === 'test' ? [TEST_MARK] : []), ...(isDemo ? [DEMO_MARK] : [])];

// «BAAAAA+TimesNewRomanPS-BoldMT» → «timesnewroman»; «Times New Roman» → «timesnewroman».
export const normalizeFontName = (name: string): string =>
  name
    .replace(/^[A-Z]{6}\+/u, '')
    .replace(/[-,](bold|italic|oblique|regular|semibold|light|medium|black|condensed|narrow)+.*$/iu, '')
    .replace(/(ps)?(mt)?$/iu, '')
    .replace(/(bold|italic|oblique|regular)+$/iu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();

// Шрифты документа, которых нет среди встроенных в PDF (после нормализации имён).
export const substitutedFonts = (requested: readonly string[], embedded: readonly string[]): string[] => {
  const have = new Set(embedded.map(normalizeFontName));
  return [...new Set(requested)].filter((r) => {
    const n = normalizeFontName(r);
    return n !== '' && ![...have].some((e) => e === n || e.startsWith(n));
  });
};
