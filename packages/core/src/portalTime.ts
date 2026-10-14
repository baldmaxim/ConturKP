// Пояс отображения портала (спецификация §12: Europe/Moscow, решение владельца 2026-10-14 — настройку не делать).
// Хранение и API — UTC; дата «по-человечески» (без времени) берётся в поясе портала, а не в UTC (этап 17, S17-16).
export const PORTAL_TIME_ZONE = 'Europe/Moscow';

const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: PORTAL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

// «2026-10-14» для момента 2026-10-13T22:30Z: в Москве уже 14-е.
export const portalDate = (d: Date): string => dateParts.format(d);
