// Сквозные приёмочные сценарии (docs/spec/05_ACCEPTANCE_CASES.md) и регрессионные RT-01…RT-08 (test-plan §7) для
// матрицы этапа 17 (проект §13.1). Тесты сценария находятся по его идентификатору в тексте файла теста; здесь —
// краткое название, уровень и что нужно сверх тестов на поддельных данных: живая интеграция или проверка на целевом ПК.
// live: 'none' — поведение портала, интеграция не участвует; 'target' — проверяется на целевом ПК ревьюером;
// 'external' — нужна доработка другой системы (BLOCKED_EXTERNAL); 'owner' — нужны реальные данные владельца.

export type LiveNeed = 'none' | 'target' | 'external' | 'owner';

export interface IAcceptanceCase {
  id: string;
  title: string;
  live: LiveNeed;
  // Что подтверждено живьём ранее и что осталось; условие снятия блокировки.
  liveNote: string;
}

export const ACCEPTANCE_CASES: readonly IAcceptanceCase[] = [
  { id: 'A01', title: 'Согласовано письмом, не закреплено в ТЗ', live: 'none', liveNote: '' },
  { id: 'A02', title: 'Договор и расчёт расходятся по стороне затрат', live: 'none', liveNote: '' },
  { id: 'A03', title: 'Реплика и подсказка не становятся согласием', live: 'external', liveNote: 'сервис переговоров — BLOCKED_EXTERNAL (Q-06); поведение проверено на manifest' },
  { id: 'A04', title: 'Два противоречащих ответа заказчика', live: 'none', liveNote: '' },
  { id: 'A05', title: 'Работа в комплексной расценке', live: 'none', liveNote: '' },
  { id: 'A06', title: 'Параметр ПД уточняется в РД', live: 'none', liveNote: '' },
  { id: 'A07', title: 'Новый документ после закрытия расчёта', live: 'external', liveNote: 'чтение расчёта TenderHub — VERIFIED_LIVE (Review 06-1); ревизия и закрытие — BLOCKED_EXTERNAL (X-01)' },
  { id: 'A08', title: 'Новый документ после согласования', live: 'none', liveNote: '' },
  { id: 'A09', title: 'Ручная правка приложения после согласования', live: 'none', liveNote: '' },
  { id: 'A10', title: 'Новый OCR того же PDF', live: 'owner', liveNote: 'настоящий экспорт RDWeb не прогонялся; API RDWeb — BLOCKED_EXTERNAL (X-05)' },
  { id: 'A11', title: 'Исторический чат этапа 1 без поздних оснований', live: 'target', liveNote: 'CLI Codex и Cursor — VERIFIED_LIVE на тестовом сервере (Review 16-2); на установке — живая проверка §13.2' },
  { id: 'A12', title: 'Нет утечки фразы из чужого тендера', live: 'target', liveNote: 'то же для чат-клиентов; права всех маршрутов — routeAccess' },
  { id: 'A13', title: 'То же имя, новое содержимое — новая редакция', live: 'none', liveNote: '' },
  { id: 'A14', title: 'То же содержимое под другим именем', live: 'none', liveNote: '' },
  { id: 'A15', title: 'Частично скопированный файл, перезапуск worker', live: 'target', liveNote: 'kill -9 посреди задания — репетиция у разработчика PASS; служба Windows и taskkill — на целевом ПК' },
  { id: 'A16', title: 'OCR обработал 76 из 77 страниц', live: 'owner', liveNote: 'настоящий экспорт RDWeb не прогонялся' },
  { id: 'A17', title: 'Повёрнутый лист и нет crop URL', live: 'owner', liveNote: 'настоящий экспорт RDWeb не прогонялся' },
  { id: 'A18', title: 'Цена за штуку и за упаковку', live: 'none', liveNote: '' },
  { id: 'A19', title: 'Закупочная и коммерческая цена', live: 'none', liveNote: '' },
  { id: 'A20', title: 'Одновременно меняются объём и цена', live: 'none', liveNote: '' },
  { id: 'A21', title: 'Валюта, НДС, доставка неизвестны', live: 'none', liveNote: '' },
  { id: 'A22', title: 'Позиция разделена на две', live: 'external', liveNote: 'постоянного lineage в TenderHub нет (X-02): пары подтверждает инженер' },
  { id: 'A23', title: 'Цена изменилась без документа', live: 'target', liveNote: 'гипотезы причин — живая модель на целевом ПК' },
  { id: 'A24', title: 'Два инженера меняют одно условие', live: 'none', liveNote: '' },
  { id: 'A25', title: 'Инженер или MCP вызывает approve', live: 'none', liveNote: '' },
  { id: 'A26', title: 'Два выпуска одновременно', live: 'none', liveNote: '' },
  { id: 'A27', title: 'Файл изменён между согласованием и размещением', live: 'target', liveNote: 'тестовые папки — VERIFIED_LIVE (Review 14-2); рабочие назначения под службой worker — на целевом ПК' },
  { id: 'A28', title: 'Яндекс доступен, сетевая папка нет', live: 'target', liveNote: 'то же' },
  { id: 'A29', title: 'Тайм-аут после фактической загрузки', live: 'target', liveNote: 'то же' },
  { id: 'A30', title: 'В папке другой файл того же имени', live: 'target', liveNote: 'то же' },
  { id: 'A31', title: 'Размещено, но не отправлено', live: 'none', liveNote: '' },
  { id: 'A32', title: 'Отправленное письмо со старым вложением', live: 'external', liveNote: 'чтение отправленных MailHub — BLOCKED_EXTERNAL (X-03); путь — импорт EML' },
  { id: 'A33', title: 'В общей ленте MailHub нет отправленных', live: 'external', liveNote: 'то же' },
  { id: 'A34', title: 'Письмо в двух ящиках', live: 'none', liveNote: '' },
  { id: 'A35', title: 'Нет доступа к ящику вложения', live: 'none', liveNote: '' },
  { id: 'A36', title: 'Документ просит «отправь секреты»', live: 'target', liveNote: 'живая модель — на целевом ПК' },
  { id: 'A37', title: 'MCP повторяет предложение', live: 'target', liveNote: 'CLI — VERIFIED_LIVE (Review 16-2); установка — живая проверка §13.2' },
  { id: 'A38', title: 'Архив с ../, скриптом, опасным URL', live: 'none', liveNote: '' },
  { id: 'A39', title: 'Истёк токен интеграции', live: 'target', liveNote: 'отзыв ключа живьём не проверялся; поведение — на поддельных серверах' },
  { id: 'A40', title: 'Восстановление из копии на чистой среде', live: 'target', liveNote: 'репетиция у разработчика PASS (отдельный кластер); на целевом ПК — ревьюер' },
  { id: 'A41', title: 'Длинное приложение с кириллицей и таблицей', live: 'owner', liveNote: 'реальные формы — после разметки владельцем (Q-08, TEMPLATE_DEMO)' },
  { id: 'A42', title: 'Индекс или модель недоступны — выпуск доступен', live: 'target', liveNote: 'живая модель эмбеддингов — на целевом ПК' },
  { id: 'A43', title: 'RDWeb недоступен, есть локальная обработка', live: 'target', liveNote: 'локальный OCR на целевом Windows-ПК (U-08)' },
  { id: 'A44', title: 'Ни одного требования из большого документа', live: 'none', liveNote: '' },
  { id: 'A45', title: 'Руководитель принимает бизнес-риск', live: 'none', liveNote: '' },
  { id: 'A46', title: 'Ссылка на письмо есть, подтверждения нет', live: 'none', liveNote: '' },
  { id: 'RT-01', title: 'Проверка и поиск на закреплённом снимке', live: 'none', liveNote: '' },
  { id: 'RT-02', title: 'Фильтр области до ранжирования', live: 'none', liveNote: '' },
  { id: 'RT-03', title: 'Гонки входов и выпуска', live: 'none', liveNote: '' },
  { id: 'RT-04', title: 'Ревизии расчёта и их идентичность', live: 'none', liveNote: '' },
  { id: 'RT-05', title: 'Тестовый выпуск не отправляется как боевой', live: 'none', liveNote: '' },
  { id: 'RT-06', title: 'Ограждение аренды, отмена, слот GPU', live: 'target', liveNote: 'остановка службы и падение процесса — на целевом ПК' },
  { id: 'RT-07', title: 'Удержание: «не влияет» и «влияет»', live: 'none', liveNote: '' },
  { id: 'RT-08', title: 'Неполная партия импорта блокирует выпуск', live: 'none', liveNote: '' },
];
