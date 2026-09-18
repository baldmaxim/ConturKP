// Даты и время портала показываются в Europe/Moscow (BRAND.md §6.1), на сервер уходит ISO UTC.

export const PORTAL_TIME_ZONE = 'Europe/Moscow';

const displayFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: PORTAL_TIME_ZONE,
  dateStyle: 'short',
  timeStyle: 'short',
});

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: PORTAL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const pad = (value: number): string => String(value).padStart(2, '0');

interface IZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const zonedParts = (date: Date): IZonedParts => {
  const parts = partsFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
};

/** «17.09.2026, 15:05» по Москве; пустая строка для некорректного значения. */
export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : displayFormatter.format(date);
};

/** ISO UTC → значение datetime-local («YYYY-MM-DDTHH:mm») по Москве. */
export const isoToMoscowInput = (iso: string | null | undefined): string => {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const p = zonedParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
};

/** Смещение часового пояса портала относительно UTC в момент date, мс. */
const zoneOffsetMs = (date: Date): number => {
  const p = zonedParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(date.getTime() / 60_000) * 60_000;
  return asUtc - truncated;
};

/** Значение datetime-local, введённое по Москве → ISO UTC; null для пустого или некорректного. */
export const moscowInputToIso = (value: string): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const naive = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  );
  // Две итерации: смещение берётся для уже скорректированного момента (на случай перехода времени).
  let guess = naive - zoneOffsetMs(new Date(naive));
  guess = naive - zoneOffsetMs(new Date(guess));
  const result = new Date(guess);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
};
