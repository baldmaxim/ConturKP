import { describe, expect, it } from 'vitest';
import { formatMailText, mailReadingSections } from '../apps/web/src/utils/mailBodyPresentation.ts';

const body = (text: string, quoted = false, block = 1) => ({ fragmentId: `fragment-${block}`, block, quoted, partIndex: 1, partTotal: 1, text });

describe('пробелы и абзацы в тексте письма', () => {
  it('восстанавливает оба примера из реального письма', () => {
    expect(formatMailText('По объекту БЦ ОГНИ.Просим ответить.\n\nЖдем обратной связи!Спасибо!'))
      .toBe('По объекту БЦ ОГНИ.\n\nПросим ответить.\n\nЖдем обратной связи!\n\nСпасибо!');
  });

  it('не меняет URL, адреса, номера версий, файлы и инициалы', () => {
    const text = 'https://example.ru/ОГНИ.Просим HTTPS://example.ru/Test.Path www.example.ru/Test.Path person+tag@example.ru v2.0.Api 26.10.2026 1.23 И.И.Иванов А.А. Петров Отчёт.Docx';
    expect(formatMailText(text)).toBe(text);
  });

  it('после сокращения добавляет пробел, а не новый абзац', () => {
    expect(formatMailText('г.Москва, ул.Лесная.Пришлите расчёт.')).toBe('г. Москва, ул. Лесная.\n\nПришлите расчёт.');
  });

  it('отделяет предложение после даты', () => {
    expect(formatMailText('Вопросы от 26.10.2026.Просим ответить.')).toBe('Вопросы от 26.10.2026.\n\nПросим ответить.');
  });

  it('сохраняет готовые абзацы и не добавляет отступы повторно', () => {
    const text = 'Добрый день!\n\nНаправляю расчёт. Спасибо!\nС уважением,\nИван';
    expect(formatMailText(text)).toBe(text);
    const repaired = formatMailText('Принято.Просим уточнить!Спасибо.');
    expect(formatMailText(repaired)).toBe(repaired);
  });

  it('распознаёт подпись после склеенного предложения, не меняя источник', () => {
    const input = [body('Просим ответить.Спасибо!С уважением,\nИван')];
    const sections = mailReadingSections(input);
    expect(sections.map((section) => section.kind)).toEqual(['message', 'signature']);
    expect(sections[0]!.text.trimEnd()).toBe('Просим ответить.\n\nСпасибо!');
    expect(input[0]!.text).toBe('Просим ответить.Спасибо!С уважением,\nИван');
  });
});

describe('читаемое письмо без изменения сохранённых фрагментов', () => {
  it('отделяет подпись внутри абзаца и сохраняет текст', () => {
    const text = 'Добрый день!\nНаправляю расчёт.\nС уважением,\nИван Иванов\n+7 000 123-45-67';
    const input = [body(text)];
    expect(mailReadingSections(input)).toEqual([
      { kind: 'message', text: 'Добрый день!\nНаправляю расчёт.' },
      { kind: 'signature', text: 'С уважением,\nИван Иванов\n+7 000 123-45-67' },
    ]);
    expect(input[0]!.text).toBe(text);
  });

  it('объединяет цитаты в один блок и не превращает их подписи в новую подпись', () => {
    const result = mailReadingSections([body('Новый ответ'), body('> Старый ответ', true, 2), body('> С уважением, Старый автор', true, 3)]);
    expect(result.map((s) => s.kind)).toEqual(['message', 'quote']);
    expect(result[1]!.text).toContain('С уважением');
  });

  it('отделяет Outlook, стандартный разделитель подписи и служебный хвост', () => {
    expect(mailReadingSections([body('Ответ\n--\nОтдел\nFrom: old@example.test\nSent: Monday\nСтарое письмо')]).map((s) => s.kind)).toEqual(['message', 'signature', 'quote']);
    expect(mailReadingSections([body('Текст\nСООБЩЕНИЕ О КОНФИДЕНЦИАЛЬНОСТИ\nСлужебное уведомление')]).map((s) => s.kind)).toEqual(['message', 'signature']);
  });

  it('узнаёт шапку ответа, разнесённую по абзацам', () => {
    const result = mailReadingSections([body('Новый ответ'), body('Кому: old@example.test', false, 2), body('Тема: прежнее письмо', false, 3), body('Прежнее содержимое', false, 4)]);
    expect(result.map((s) => s.kind)).toEqual(['message', 'quote']);
  });

  it('оставляет новый ответ после отдельной цитаты видимым', () => {
    expect(mailReadingSections([body('> Вопрос', true), body('Ответ ниже цитаты', false, 2)]).map((s) => s.kind)).toEqual(['quote', 'message']);
  });

  it('оставляет подпись автора после процитированной цепочки отдельно и убирает разделитель из основного текста', () => {
    const result = mailReadingSections([
      body('Текущий ответ'), body('----------------', false, 2), body('Кому: old@example.test', false, 3),
      body('Тема: прежнее письмо', false, 4), body('> Прежняя переписка', true, 5),
      body('--\nПодпись текущего автора', false, 6),
    ]);
    expect(result.map((s) => s.kind)).toEqual(['message', 'quote', 'signature']);
    expect(result[0]!.text).toBe('Текущий ответ');
    expect(result[2]!.text).toContain('Подпись текущего автора');
  });

  it('не считает обычную фразу «с уважением к решению» подписью', () => {
    expect(mailReadingSections([body('С уважением к решению заказчика просим пересмотреть срок.')])[0]!.kind).toBe('message');
  });
});
