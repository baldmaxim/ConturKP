import type { IOfficeDesk, IOfficeResident } from './officeModel.js';

export type TOfficeExecutionState = 'running' | 'queued' | 'idle' | 'down' | 'stale';
export interface IOfficeExecution {
  state: TOfficeExecutionState;
  label: string;
  running: number;
  queued: number;
  active: number;
  caption: string;
}

/** Выполнение независимо от истории ошибок: агент может работать и иметь старые отказы. */
export const officeExecution = (person: IOfficeDesk | IOfficeResident, workersAlive: number, stale: boolean): IOfficeExecution => {
  const running = 'running' in person ? person.running : 0, queued = 'queued' in person ? person.queued : 0;
  const state: TOfficeExecutionState = stale ? 'stale' : workersAlive === 0 ? 'down' : running > 0 ? 'running' : queued > 0 ? 'queued' : 'idle';
  const label = state === 'stale' ? 'Нет связи' : state === 'down' ? 'Нет worker' : state === 'running' ? `Выполняется: ${running}` : state === 'queued' ? `В очереди: ${queued}` : 'Свободен';
  const counts = `выполняется ${running}, в очереди ${queued}`;
  return { state, label, running, queued, active: running + queued, caption: `${person.title}: ${label}. ${state === 'stale' || state === 'down' ? 'Последний снимок: ' : ''}${counts}.` };
};

/** Ошибка задания не выключает компьютер и не отменяет другие выполняющиеся задания. */
export const officeComputer = (person: IOfficeDesk | IOfficeResident, workersAlive: number, stale: boolean): 'off' | 'offline' | 'working' | 'waiting' | 'attention' | 'idle' => {
  if (!('running' in person)) return 'off';
  const execution = officeExecution(person, workersAlive, stale);
  if (execution.state === 'stale' || execution.state === 'down') return 'offline';
  if (execution.state === 'running') return 'working';
  if (person.failed > 0) return 'attention';
  return execution.state === 'queued' ? 'waiting' : 'idle';
};
