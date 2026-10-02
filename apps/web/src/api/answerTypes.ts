// Диалоги и ответы ответного ядра (этап 08a, D-027; portal-api §2.12, §3.4).
import type { TFragmentOrigin } from './recognitionTypes';

/** Словарь статусов ответа (AD-08a-2): отделён от результатов регламентной проверки этапа 09. */
export type TAnswerStatus =
  | 'confirmed_by_citations'
  | 'citations_disagree'
  | 'needs_clarification'
  | 'not_found_in_scope'
  | 'incomplete_processing'
  | 'no_data'
  | 'not_provided'
  | 'confirmed_discrepancy';

export type TIncompleteReason = 'insufficient_evidence' | 'model_failed' | 'draft_invalid' | 'model_disabled' | 'scope_incomplete' | 'no_readable_evidence';
export type TAnswerRunStatus = 'queued' | 'running' | 'completed' | 'failed';
export type TVersionNote = 'current' | 'superseded' | 'conflict';

export interface IDialogContext {
  kind: 'tender' | 'contract';
  tenderId?: string;
  contractId?: string;
  mode?: 'working' | 'review';
  stageId?: string;
  evidenceScopeId?: string;
}

export interface IDialogSummary {
  id: string;
  title: string;
  contextKind: 'tender' | 'contract';
  tenderId: string | null;
  contractId: string | null;
  stageId: string | null;
  mode: string;
  createdAt: string;
}

export interface IAnswerPlace {
  sourceKind: string | null;
  documentTitle: string | null;
  pageIndex: number | null;
  pageLabel: string | null;
  sheetLabel: string | null;
  mailSubject: string | null;
  sessionTitle: string | null;
}

export interface IAnswerCitation {
  /** Номер [n] в тексте ответа; у найденного, но не процитированного фрагмента — null. */
  number: number | null;
  label: string;
  fragmentId: string;
  versionNote: TVersionNote;
  /** Нет права на источник: текста и места нет. */
  restricted: boolean;
  origin: TFragmentOrigin | null;
  text: string | null;
  place: IAnswerPlace | null;
}

export interface IAnswer {
  /** Автор читает все процитированные основания; иначе текста и цитат нет. */
  visible: boolean;
  text: string | null;
  citations: IAnswerCitation[];
  conflictCitations: number[];
  claims: { kind: string; text: string | null; citations: string[] }[];
  shownClaims: number;
  droppedClaims: number;
  droppedIssues: Record<string, number>;
  foundFragments: IAnswerCitation[];
}

export interface IAnswerRun {
  id: string;
  dialogId: string;
  seq: number;
  questionMessageId: string;
  status: TAnswerRunStatus;
  answerStatus: TAnswerStatus | null;
  incompleteReason: TIncompleteReason | null;
  plan: { intent: string; followUp: boolean; versionPolicy: string; entities: string[] };
  verifierMode: 'off' | 'same_model';
  verificationLevel: 'none' | 'hard_checks' | 'model' | null;
  model: { provider: string; model: string | null; version: string | null } | null;
  repairs: number;
  searchRunId: string;
  failureCode: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  coverage?: { excludedByAccess?: number; packet?: number; superseded?: number; conflict?: number; scopeIncomplete?: boolean };
  answer: IAnswer | null;
}

export interface IDialogMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  /** Скрыт, если ответ опирается на основание, недоступное автору сейчас. */
  text: string | null;
  hidden: boolean;
  answerRunId: string | null;
  createdAt: string | null;
}

export interface IDialog extends Omit<IDialogSummary, 'mode'> {
  mode: string;
  evidenceScopeId: string | null;
  messages: IDialogMessage[];
  runs: IAnswerRun[];
}

export interface IQuestionAccepted {
  runId: string;
  messageId: string;
  dialog: IDialog;
}
