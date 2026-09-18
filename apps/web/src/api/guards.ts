import type { IStage, ITender, IUser } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const isTender = (value: unknown): value is ITender =>
  isRecord(value) && typeof value.id === 'string' && typeof value.code === 'string' && typeof value.rowVersion === 'number';

export const isStage = (value: unknown): value is IStage =>
  isRecord(value) && typeof value.id === 'string' && typeof value.seq === 'number' && typeof value.rowVersion === 'number';

export const isUser = (value: unknown): value is IUser =>
  isRecord(value) && typeof value.id === 'string' && typeof value.login === 'string' && typeof value.rowVersion === 'number';
