// Вызовы расчёта TenderHub (этап 06, portal-api §2.5). TenderHub читает worker, клиент только
// назначает связь, запрашивает выгрузку и читает неизменяемые ревизии.
import type { ICalculationCapture, ICalculationLine, ICalculationPosition, ICalculationRevision, ICalculationSources, IPage } from './calculationTypes';
import { apiGet, apiPost, apiPut } from './client';
import type { IListResponse } from './types';

const enc = encodeURIComponent;

export const getCalculationSources = (stageId: string, signal?: AbortSignal): Promise<ICalculationSources> =>
  apiGet<ICalculationSources>(`/stages/${enc(stageId)}/calculation-source`, { signal });

/** Связь этапа с тендером TenderHub; If-Match — версия набора связей этапа. */
export const setCalculationSource = (stageId: string, version: number, externalTenderId: string, externalVersion: number | null): Promise<ICalculationSources> =>
  apiPut<ICalculationSources>(`/stages/${enc(stageId)}/calculation-source`, {
    body: { externalTenderId, externalVersion },
    ifMatch: `"${stageId}:${version}"`,
  });

export const requestCalculationCapture = (stageId: string, idempotencyKey: string): Promise<ICalculationCapture> =>
  apiPost<ICalculationCapture>(`/stages/${enc(stageId)}/calculation-captures`, { body: {}, idempotencyKey });

export const listCalculationCaptures = (stageId: string, signal?: AbortSignal): Promise<IListResponse<ICalculationCapture>> =>
  apiGet<IListResponse<ICalculationCapture>>(`/stages/${enc(stageId)}/calculation-captures`, { signal });

export const listCalculationRevisions = (stageId: string, signal?: AbortSignal): Promise<IListResponse<ICalculationRevision>> =>
  apiGet<IListResponse<ICalculationRevision>>(`/stages/${enc(stageId)}/calculation-revisions`, { signal });

export const getCalculationPositions = (revisionId: string, cursor: string | null, signal?: AbortSignal): Promise<IPage<ICalculationPosition>> =>
  apiGet<IPage<ICalculationPosition>>(`/calculation-revisions/${enc(revisionId)}/positions?limit=100${cursor ? `&cursor=${enc(cursor)}` : ''}`, { signal });

export const getCalculationLines = (revisionId: string, positionId: string, cursor: string | null, signal?: AbortSignal): Promise<IPage<ICalculationLine>> =>
  apiGet<IPage<ICalculationLine>>(`/calculation-revisions/${enc(revisionId)}/lines?positionId=${enc(positionId)}&limit=500${cursor ? `&cursor=${enc(cursor)}` : ''}`, { signal });
