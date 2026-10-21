// «Офис» в администрировании: чистая логика — кто за каким столом, в какой позе и чем занят. Без React, проверяется
// отдельно. Данные — только очередь заданий worker'а (таблица job); нейросети ни при чём.

// Модуль без импортов: его читают и тесты (корневой tsconfig, nodenext), поэтому типы ответа API и склонение — здесь.

export type TOfficeJobStatus = 'queued' | 'running' | 'failed';

/** Группа заданий в ответе `GET /admin/office`: вид, состояние и тендер. Закрытый тендер не раскрывается — `hidden: true`. */
export interface IOfficeItemView {
  kind: string;
  status: TOfficeJobStatus;
  tenderId: string | null;
  hidden: boolean;
  count: number;
  lastErrorCode: string | null;
  lastFailedAt: string | null;
}

export interface IOfficeView {
  /** Время базы данных на момент ответа. */
  at: string;
  items: IOfficeItemView[];
  tenders: Array<{ id: string; title: string }>;
  workersAlive: number;
}

/** Русское множественное число: plural(3, ['задание', 'задания', 'заданий']) → «задания». */
const plural = (n: number, forms: [string, string, string]): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
};

/** Поза человечка за столом: одна поза — одна анимация и одно содержимое экрана. */
export type TOfficePose = 'edit' | 'read' | 'run' | 'web' | 'agent' | 'think' | 'work' | 'wait' | 'idle';

/** Занятие отдыхающего в комнате отдыха. */
export type TIdleActivity = 'coffee' | 'stretch' | 'walk' | 'phone' | 'sofa';

export type TOfficeRole = 'intake' | 'recognition' | 'archive' | 'analyst' | 'estimator' | 'reviewer' | 'assembler' | 'courier' | 'model' | 'other';

/** Порядок столов. «Разнорабочий» (незнакомый вид задания) — последний и показывается, только если у него есть задания. */
export const OFFICE_ROLES: readonly TOfficeRole[] = ['intake', 'recognition', 'archive', 'analyst', 'estimator', 'reviewer', 'assembler', 'courier', 'model', 'other'];

export const ROLE_TITLE: Record<TOfficeRole, string> = {
  intake: 'Приёмщик',
  recognition: 'Распознаватель',
  archive: 'Архивариус',
  analyst: 'Аналитик',
  estimator: 'Сметчик',
  reviewer: 'Проверяющий',
  assembler: 'Сборщик КП',
  courier: 'Курьер',
  model: 'Консультант (модель)',
  other: 'Разнорабочий',
};

/** Виды заданий worker'а по ролям (apps/worker/src/handlers/index.ts). */
export const ROLE_KINDS: Record<Exclude<TOfficeRole, 'other'>, readonly string[]> = {
  intake: ['import.expand', 'import.register', 'intake.scan', 'mail.import'],
  recognition: ['recognition.import', 'recognition.local'],
  archive: ['index.build', 'index.embed', 'index.purge', 'search.semantic'],
  analyst: ['analysis.rules', 'fact.extract'],
  estimator: ['calculation.capture'],
  reviewer: ['review.run', 'stage.invalidate'],
  assembler: ['candidate.assemble'],
  courier: ['delivery.place', 'delivery.probe'],
  model: ['analysis.extract', 'answer.generate', 'review.model', 'economics.reasons', 'forms.suggest', 'model.probe'],
};

/** Что делает роль, когда работает — для подписи стола. */
const ROLE_ACTION: Record<TOfficeRole, string> = {
  intake: 'принимает материалы',
  recognition: 'распознаёт документы',
  archive: 'ведёт архив и поиск',
  analyst: 'разбирает требования и факты',
  estimator: 'снимает расчёт',
  reviewer: 'проверяет',
  assembler: 'собирает КП',
  courier: 'размещает файлы',
  model: 'советуется с моделью',
  other: 'занят разным',
};

/** Поза работающей роли. */
const BUSY_POSE: Record<TOfficeRole, TOfficePose> = {
  intake: 'read',
  recognition: 'read',
  archive: 'work',
  analyst: 'think',
  estimator: 'edit',
  reviewer: 'read',
  assembler: 'edit',
  courier: 'web',
  model: 'agent',
  other: 'work',
};

const KIND_ROLE = new Map<string, TOfficeRole>(
  (Object.entries(ROLE_KINDS) as Array<[Exclude<TOfficeRole, 'other'>, readonly string[]]>).flatMap(([role, kinds]) => kinds.map((kind) => [kind, role] as const)),
);

/** Роль по виду задания; незнакомый вид — «Разнорабочий». */
export const roleOfKind = (kind: string): TOfficeRole => KIND_ROLE.get(kind) ?? 'other';

/** Ошибка «за последний час» поднимает руку; старше — только число в счётчике ошибок за 24 ч. */
export const RECENT_FAILURE_MS = 3_600_000;

export const IDLE_ACTIVITIES: readonly TIdleActivity[] = ['coffee', 'stretch', 'walk', 'phone', 'sofa'];

/** Чем занят отдыхающий — словами (для подписи и чтения с экрана). */
export const IDLE_WORD: Record<TIdleActivity, string> = {
  coffee: 'пьёт кофе',
  stretch: 'потягивается',
  walk: 'прогуливается',
  phone: 'листает телефон',
  sofa: 'дремлет на диване',
};

/** Стабильный хэш строки: одно и то же на любой машине и при любой перезагрузке страницы. */
const hashOf = (text: string): number => {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
};

/** Занятие отдыхающего по роли: одна роль — одно занятие, всегда. */
export const idleActivity = (role: TOfficeRole): TIdleActivity => IDLE_ACTIVITIES[hashOf(role) % IDLE_ACTIVITIES.length] ?? 'sofa';

/** Сколько цветов рубашек в палитре (`--office-shirt-0…5`). */
export const SHIRT_COUNT = 6;

/** Рубашка роли: одна роль — один цвет на любой машине и при любой перезагрузке страницы. */
export const shirtIndex = (role: TOfficeRole): number => hashOf(role) % SHIRT_COUNT;

/** Сколько папок показывает стол; остальные — числом. */
export const FOLDERS_SHOWN = 4;

export const FOLDER_HIDDEN_TITLE = 'Закрытый тендер';
export const FOLDER_NONE_TITLE = 'Без тендера';

export interface IOfficeFolder {
  key: string;
  title: string;
  /** Есть только у видимого тендера: по нему строится ссылка. */
  tenderId: string | null;
  hidden: boolean;
  running: number;
  queued: number;
  failed: number;
}

/** Настроение стола: работает, просит помощи (ошибка за час) или дремлет (задания ждут, никто не берёт). */
export type TDeskMood = 'working' | 'alarm' | 'dozing';

export interface IOfficeDesk {
  role: TOfficeRole;
  title: string;
  mood: TDeskMood;
  pose: TOfficePose;
  running: number;
  queued: number;
  /** Ошибки за 24 ч. */
  failed: number;
  lastErrorCode: string | null;
  folders: IOfficeFolder[];
  /** Короткая подпись под именем роли. */
  status: string;
  /** Состояние словами целиком — для чтения с экрана. */
  caption: string;
}

/** Отдыхающий в комнате отдыха. */
export interface IOfficeResident {
  role: TOfficeRole;
  title: string;
  activity: TIdleActivity;
  failed: number;
  lastErrorCode: string | null;
  status: string;
  caption: string;
}

export interface IOfficeModel {
  desks: IOfficeDesk[];
  lounge: IOfficeResident[];
  totals: { running: number; queued: number; failed: number; workersAlive: number };
  /** Задания ждут, а живого worker'а нет: все, у кого есть очередь, дремлют, над офисом — баннер. */
  workerDown: boolean;
}

const jobsWord = (n: number): string => `${n} ${plural(n, ['задание', 'задания', 'заданий'])}`;

const sum = (items: IOfficeItemView[], status: IOfficeItemView['status']): number =>
  items.filter((i) => i.status === status).reduce((acc, i) => acc + i.count, 0);

/** Папки стола по тендерам: закрытые сливаются в одну (суммой), без тендера — отдельная. Сначала самые занятые. */
export const foldersOf = (items: IOfficeItemView[], titles: ReadonlyMap<string, string>): IOfficeFolder[] => {
  const folders = new Map<string, IOfficeFolder>();
  for (const item of items) {
    const key = item.hidden ? 'hidden' : item.tenderId ? `tender:${item.tenderId}` : 'none';
    let folder = folders.get(key);
    if (!folder) {
      folder = {
        key,
        title: item.hidden ? FOLDER_HIDDEN_TITLE : item.tenderId ? (titles.get(item.tenderId) ?? 'Тендер') : FOLDER_NONE_TITLE,
        tenderId: item.hidden ? null : item.tenderId,
        hidden: item.hidden,
        running: 0,
        queued: 0,
        failed: 0,
      };
      folders.set(key, folder);
    }
    folder[item.status] += item.count;
  }
  return [...folders.values()].sort((a, b) => b.running + b.queued - (a.running + a.queued) || b.failed - a.failed || a.title.localeCompare(b.title, 'ru'));
};

/** Код последней ошибки среди групп (по времени отказа); без отказов или без кода — `null`. */
const lastErrorOf = (items: IOfficeItemView[]): string | null => {
  let best: IOfficeItemView | null = null;
  for (const item of items) {
    if (item.status !== 'failed') continue;
    if (!best || Date.parse(item.lastFailedAt ?? '') > Date.parse(best.lastFailedAt ?? '')) best = item;
  }
  return best?.lastErrorCode ?? null;
};

const errorTail = (failed: number, code: string | null): string => (failed > 0 ? `; ошибок за 24 ч: ${failed}${code ? ` (последний код ${code})` : ''}` : '');

/**
 * Стол или комната отдыха для каждой роли. Поза: есть выполняющееся — по роли; иначе ошибка за последний час —
 * поднята рука; иначе есть очередь — дремлет за столом (лоток полон, а никто не берёт); иначе — в комнате отдыха.
 * Нет живого worker'а при непустой очереди — дремлют все, у кого есть очередь или «зависшее» выполнение.
 */
export const buildOffice = (view: IOfficeView): IOfficeModel => {
  const now = Date.parse(view.at);
  const titles = new Map(view.tenders.map((t) => [t.id, t.title] as const));
  const totals = {
    running: sum(view.items, 'running'),
    queued: sum(view.items, 'queued'),
    failed: sum(view.items, 'failed'),
    workersAlive: view.workersAlive,
  };
  const workerDown = view.workersAlive === 0 && totals.queued > 0;

  const desks: IOfficeDesk[] = [];
  const lounge: IOfficeResident[] = [];
  for (const role of OFFICE_ROLES) {
    const items = view.items.filter((i) => roleOfKind(i.kind) === role);
    if (role === 'other' && items.length === 0) continue;
    const running = sum(items, 'running');
    const queued = sum(items, 'queued');
    const failed = sum(items, 'failed');
    const recentFailure = items.some((i) => i.status === 'failed' && i.lastFailedAt !== null && now - Date.parse(i.lastFailedAt) <= RECENT_FAILURE_MS);
    const lastErrorCode = lastErrorOf(items);
    const title = ROLE_TITLE[role];
    const base = { role, title, running, queued, failed, lastErrorCode, folders: foldersOf(items, titles) };
    const tail = errorTail(failed, lastErrorCode);

    if (workerDown && (queued > 0 || running > 0)) {
      desks.push({ ...base, mood: 'dozing', pose: 'idle', status: 'дремлет: worker не работает', caption: `${title} дремлет: в очереди ${jobsWord(queued)}, worker не работает${tail}` });
    } else if (running > 0) {
      const wait = queued > 0 ? `, в очереди ещё ${queued}` : '';
      desks.push({ ...base, mood: 'working', pose: BUSY_POSE[role], status: ROLE_ACTION[role], caption: `${title} ${ROLE_ACTION[role]}: в работе ${jobsWord(running)}${wait}${tail}` });
    } else if (recentFailure) {
      desks.push({ ...base, mood: 'alarm', pose: 'wait', status: 'просит помощи: недавний отказ', caption: `${title} просит помощи: недавний отказ задания${queued > 0 ? `, в очереди ${jobsWord(queued)}` : ''}${tail}` });
    } else if (queued > 0) {
      desks.push({ ...base, mood: 'dozing', pose: 'idle', status: 'дремлет: очередь стоит', caption: `${title} дремлет: в очереди ${jobsWord(queued)}, никто не берёт${tail}` });
    } else {
      const activity = idleActivity(role);
      lounge.push({ role, title, activity, failed, lastErrorCode, status: IDLE_WORD[activity], caption: `${title} ${IDLE_WORD[activity]}${tail}` });
    }
  }
  return { desks, lounge, totals, workerDown };
};

/** Возраст данных (мс), после которого офис «застывает», а плашка говорит, что данные устарели. */
export const STALE_AFTER_MS = 30_000;
