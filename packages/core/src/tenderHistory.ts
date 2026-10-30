// Legacy reports are data. Never evaluate their HTML, scripts, links or embedded commands.
import { createHash } from 'node:crypto';
import { safeRelativePath } from './paths.ts';

export interface IHistoryRecordInput {
  key: string; kind: string; title: string; detail: string; occurredAt: string | null;
  sourcePath: string | null; sourceLabel: string; payloadSha256: string;
  restricted: boolean; technical: boolean;
}
export interface IHistoryFileInput {
  path: string; size: number; sha256: string | null; modifiedAt: string | null;
  verifiedAt: string | null; status: string; technical: boolean;
}
export interface IHistoryImport {
  schema: 'tender-history/1'; externalFolderId: string; folderName: string;
  observedAt: string; observationStartedAt: string; complete: boolean; sourceSha256: string;
  records: IHistoryRecordInput[]; files: IHistoryFileInput[];
}
export const historyDigest = (value: unknown): string =>
  createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Ожидался объект JSON');
  return v as Record<string, unknown>;
};
const str = (v: unknown, max = 2000): string => typeof v === 'string' ? v.slice(0, max) : '';
const date = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
export const historyPath = (value: unknown): string => {
  const raw = str(value, 1200);
  const verdict = safeRelativePath(raw);
  if (!verdict.ok) throw new Error('Недопустимый относительный путь');
  return verdict.path;
};
export const historyTechnical = (p: string): boolean =>
  /(^|\/)(thumbs\.db|desktop\.ini|\.ds_store|~\$[^/]*|[^/]*\.(tmp|part|partial|crdownload|slog))$/i.test(p.replaceAll('\\','/'));
const hash = (v: unknown): string | null => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v) ? v.toLowerCase() : null;

export const readLegacyHistory = (text: string): { folders: { id: string; name: string }[]; sharedFolders:{id:string;name:string}[]; data: Record<string, unknown>; sha256: string } => {
  if (Buffer.byteLength(text) > 40 * 1024 * 1024) throw new Error('Отчёт больше 40 МБ');
  const embedded = /<script\b(?=[^>]*\bid=["']history-data["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script\s*>/i.exec(text);
  const data = obj(JSON.parse(embedded ? embedded[1]! : text));
  if (!Array.isArray(data.folders) || !Array.isArray(data.events) || !Array.isArray(data.files)) throw new Error('Неизвестный формат хронологии');
  if (data.files.length > 100_000 || data.events.length > 100_000) throw new Error('Превышен лимит записей');
  const ids = new Set<string>();
  const folders = data.folders.filter((v) => obj(v).tender === true).map((v) => {
    const f = obj(v), id = str(f.tender_id, 200), name = historyPath(f.id);
    if (!id || ids.has(id)) throw new Error('Неоднозначный ID папки');
    ids.add(id);
    return { id, name };
  });
  const sharedFolders=data.folders.filter(v=>obj(v).tender!==true).map(v=>{
    const f=obj(v),id=str(f.tender_id,200),name=historyPath(f.id);
    if(!id||ids.has(id))throw new Error('Неоднозначный ID папки');ids.add(id);return {id,name};
  });
  return { folders,sharedFolders, data, sha256: historyDigest(text) };
};

export const prepareLegacyHistory = (source: ReturnType<typeof readLegacyHistory>, folderId: string,allowShared=false): IHistoryImport => {
  const folder = [...source.folders,...(allowShared?source.sharedFolders:[])].find((f) => f.id === folderId);
  if (!folder) throw new Error('Тендерная папка не найдена в отчёте');
  const snapshot = obj(source.data.snapshot);
  const observedAt = date(snapshot.finished_at), startedAt = date(snapshot.started_at);
  if (!observedAt || !startedAt || startedAt > observedAt) throw new Error('Некорректный интервал наблюдения');
  const prefix = folder.name + '/';
  const records: IHistoryRecordInput[] = [];
  const keys = new Set<string>();
  for (const raw of source.data.events as unknown[]) {
    const e = obj(raw);
    if (e.tender_id !== folderId) continue;
    if (e.folder !== folder.name && e.folder_at_observation !== folder.name) throw new Error('ID события противоречит папке');
    const kind = str(e.kind, 64) || 'note';
    // Baselines and file comparisons are observations, never approvals or send events.
    const rawKey = e.event_key ?? e.id;
    const key = (typeof rawKey === 'number' && Number.isSafeInteger(rawKey) ? String(rawKey) : str(rawKey, 1000)) || historyDigest(e);
    if (keys.has(key)) throw new Error('Повтор ID исторической записи');
    keys.add(key);
    let sourcePath: string | null = null;
    if (e.source) sourcePath = historyPath(e.source);
    records.push({
      key, kind, title: str(e.title, 2000), detail: str(e.summary, 100_000),
      occurredAt: date(e.original_source_at) ?? date(e.at), sourcePath,
      sourceLabel: str(e.source_kind ?? e.sourceLabel, 200) || 'Историческая хронология',
      payloadSha256: historyDigest(e), restricted: kind === 'mail', technical: e.technical === true,
    });
  }
  const paths = new Set<string>();
  const files: IHistoryFileInput[] = [];
  for (const raw of source.data.files as unknown[]) {
    const f = obj(raw);
    if (f.tender_id !== folderId) continue;
    const p = historyPath(f.p);
    if (!p.startsWith(prefix)) throw new Error('Путь файла противоречит тендеру');
    const rel = historyPath(p.slice(prefix.length));
    const key = rel.normalize('NFC').toLowerCase();
    if (paths.has(key)) throw new Error('Неоднозначный путь файла');
    paths.add(key);
    if (!Number.isSafeInteger(f.s) || Number(f.s) < 0) throw new Error('Некорректный размер');
    const sha256 = hash(f.h);
    files.push({ path: rel, size: Number(f.s), sha256, modifiedAt: date(f.m),
      verifiedAt: sha256 ? date(f.end) : null, status: str(f.st, 64) || 'unverified',
      technical: f.technical === true || historyTechnical(rel) });
  }
  return { schema: 'tender-history/1', externalFolderId: folderId, folderName: folder.name,
    observedAt, observationStartedAt: startedAt, complete: snapshot.complete === true,
    sourceSha256: source.sha256, records, files };
};
