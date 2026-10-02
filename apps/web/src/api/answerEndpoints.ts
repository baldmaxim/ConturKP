// Вызовы диалогов ответного ядра (этап 08a; portal-api §2.12). Стриминга нет: ответ получают опросом прогона.
import { apiGet, apiPost } from './client';
import type { IAnswerRun, IDialog, IDialogContext, IDialogSummary, IQuestionAccepted } from './answerTypes';
import type { IListResponse } from './types';

const enc = encodeURIComponent;

export const listStageDialogs = (stageId: string, signal?: AbortSignal): Promise<IListResponse<IDialogSummary>> =>
  apiGet<IListResponse<IDialogSummary>>(`/dialogs?stageId=${enc(stageId)}`, { signal });

export const createDialog = (context: IDialogContext, idempotencyKey: string, title?: string): Promise<IDialog> =>
  apiPost<IDialog>('/dialogs', { body: title ? { context, title } : { context }, idempotencyKey });

export const getDialog = (dialogId: string, signal?: AbortSignal): Promise<IDialog> => apiGet<IDialog>(`/dialogs/${enc(dialogId)}`, { signal });

export const askQuestion = (dialogId: string, text: string, idempotencyKey: string): Promise<IQuestionAccepted> =>
  apiPost<IQuestionAccepted>(`/dialogs/${enc(dialogId)}/messages`, { body: { text }, idempotencyKey });

export const getAnswerRun = (runId: string, signal?: AbortSignal): Promise<IAnswerRun> => apiGet<IAnswerRun>(`/answer-runs/${enc(runId)}`, { signal });
