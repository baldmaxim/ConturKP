// Алгоритм размещения папки выпуска (этап 14; D-034; проект §5.3–§5.4) — общий для задания worker и живой проверки
// (scripts/delivery-live-smoke.ts). Каждый шаг начинается со сверки: папка выпуска уже есть — сверить и при совпадении
// закончить; служебная папка доставки — своя; перенос — без замены; признак готовности — последним и без перезаписи.
// В папке выпуска — ровно файлы набора и признак: чужое не перезаписывается, не дописывается и не удаляется (A30).
import type { Readable } from 'node:stream';
import { DeliveryAdapterError } from './errors.ts';
import type { FsDeliveryTarget, IRemoteFile } from './fsTarget.ts';

export type PlacementRemoteState = 'absent' | 'staged' | 'committed' | 'verified' | 'conflict' | 'unknown';

export interface IPlacementFile {
  path: string;
  sha256: string;
  size: number;
  open: () => Readable;
}

export interface IPlacementPlan {
  // Имя своей служебной папки доставки (один сегмент).
  own: string;
  // Папка выпуска относительно корня («/»).
  targetFolder: string;
  files: IPlacementFile[];
  marker: { name: string; bytes: Buffer; sha256: string };
}

export interface IPlacementHooks {
  // Состояние файла (или признака) после сверки.
  state?: (path: string, state: PlacementRemoteState, remoteSha256: string | null) => Promise<void>;
  // Шаг: перенос папки выпуска, сверка в ней.
  step?: (step: 'committing' | 'verifying') => Promise<void>;
}

// В папке выпуска другое содержимое: перезаписи и удаления нет (A30).
export class PlacementConflict extends Error {}

// Служебные файлы оболочки ОС в папке выпуска не считаются посторонними.
const SHELL_FILES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

const same = (e: IRemoteFile | null, f: { sha256: string; size: number }): boolean => !!e && e.sha256 === f.sha256 && e.size === f.size;

export const placeFolder = async (target: FsDeliveryTarget, plan: IPlacementPlan, hooks: IPlacementHooks = {}): Promise<'placed' | 'already_placed'> => {
  const state = hooks.state ?? (async () => undefined);
  const step = hooks.step ?? (async () => undefined);
  await target.checkBases();

  // Папка выпуска уже есть: сверка и завершение без повторной записи файлов.
  const finishExisting = async (): Promise<void> => {
    const known = new Set([...plan.files.map((f) => f.path), plan.marker.name]);
    const extra = (await target.list('root', plan.targetFolder)).filter((n) => !known.has(n) && !SHELL_FILES.has(n.toLowerCase()));
    if (extra.length > 0) throw new PlacementConflict(`в папке выпуска посторонние файлы: ${extra.slice(0, 5).map((n) => n.slice(0, 60)).join(', ')}`);
    const bad: string[] = [];
    for (const f of plan.files) {
      const e = await target.inspect('root', `${plan.targetFolder}/${f.path}`);
      const file = e?.type === 'file' ? e : null;
      if (same(file, f)) await state(f.path, 'verified', file!.sha256);
      else {
        await state(f.path, e ? 'conflict' : 'absent', file?.sha256 ?? null);
        bad.push(f.path);
      }
    }
    if (bad.length > 0) {
      throw new PlacementConflict(`в папке выпуска другое содержимое или нет файлов: ${bad.slice(0, 5).join(', ')}; портал не перезаписывает и не дописывает — уберите папку выпуска и повторите`);
    }
    await step('verifying');
    const put = await target.putMarker(plan.targetFolder, plan.marker.name, plan.own, plan.marker.bytes);
    const m = await target.inspect('root', `${plan.targetFolder}/${plan.marker.name}`);
    const mf = m?.type === 'file' ? m : null;
    if (!same(mf, { sha256: plan.marker.sha256, size: plan.marker.bytes.length })) {
      await state(plan.marker.name, 'conflict', mf?.sha256 ?? null);
      throw new PlacementConflict(put === 'exists' ? 'признак готовности в папке выпуска — с другим содержимым' : 'признак готовности не совпал после записи');
    }
    await state(plan.marker.name, 'verified', mf!.sha256);
    await target.removeOwnStaging(plan.own).catch(() => undefined);
  };

  const existing = await target.inspect('root', plan.targetFolder);
  if (existing?.type === 'file') throw new PlacementConflict('на месте папки выпуска лежит файл');
  if (existing?.type === 'dir') {
    await finishExisting();
    return 'already_placed';
  }
  // Стадирование: своя служебная папка доставки, каждый файл сверен по SHA-256 и размеру.
  await target.ensureFolder('staging', plan.own);
  for (const f of plan.files) {
    const rel = `${plan.own}/${f.path}`;
    const before = await target.inspect('staging', rel);
    if (before?.type === 'file' && same(before, f)) {
      await state(f.path, 'staged', before.sha256);
      continue;
    }
    if (before) await target.removeOwnStagingFile(plan.own, f.path);
    const after = await target.putStagingFile(rel, f);
    if (!same(after, f)) {
      await state(f.path, 'unknown', after.sha256);
      throw new DeliveryAdapterError('UNAVAILABLE', `файл «${f.path.slice(0, 60)}» прочитан с другим содержимым после записи`);
    }
    await state(f.path, 'staged', after.sha256);
  }
  // Перенос без замены; затем сверка папки выпуска и признак готовности.
  await step('committing');
  const moved = await target.commitFolder(plan.own, plan.targetFolder);
  if (moved === 'moved') for (const f of plan.files) await state(f.path, 'committed', null);
  await finishExisting();
  return moved === 'moved' ? 'placed' : 'already_placed';
};
