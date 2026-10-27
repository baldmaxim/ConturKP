import type { IOfficeTask } from './officeModel.ts';

const UNITS = { files: 'файлов', pages: 'страниц', sheets: 'листов', documents: 'документов', chunks: 'фрагментов' };

export const officeProgress = (task: IOfficeTask): { percent: number | null; label: string } => {
  const p = task.progress;
  if (!p || !p.total || !Number.isFinite(p.completed) || p.completed < 0 || p.completed > p.total) return { percent: null, label: p?.phase === 'saving' ? 'Сохранение результата' : p?.phase === 'preparing' ? 'Подготовка задания' : 'Выполнение · без оценки объёма' };
  // Результат ещё не зафиксирован: 100% появляется только у завершённого задания, которое покидает список.
  const percent = Math.min(99, Math.floor(p.completed / p.total * 100));
  return { percent, label: `${percent}% · ${p.completed} из ${p.total} ${UNITS[p.unit]}${p.phase === 'saving' ? ' · сохранение' : ''}` };
};
