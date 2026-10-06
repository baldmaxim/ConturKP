// Типы приложений этапа 11 (D-031; portal-api §2.8). Схема полей — forms/1; значения проверяет сервер по схеме.

export type TFieldType = 'choice' | 'text' | 'number' | 'date' | 'table';

export type TCondition =
  | { field: string; op: 'eq' | 'ne' | 'in' | 'empty' | 'notEmpty'; value?: unknown }
  | { all: TCondition[] }
  | { any: TCondition[] }
  | { not: TCondition };

export interface IChoiceOption {
  value: string;
  label: string;
}

export interface ITableColumn {
  key: string;
  label: string;
  type: Exclude<TFieldType, 'table'>;
  required?: boolean;
  options?: IChoiceOption[];
  unit?: string;
}

export interface IFieldDefinition {
  key: string;
  type: TFieldType;
  label: string;
  help?: string;
  meaning?: string;
  options?: IChoiceOption[];
  multiple?: boolean;
  multiline?: boolean;
  maxLength?: number;
  unit?: string;
  currency?: string;
  scale?: number;
  min?: string;
  max?: string;
  columns?: ITableColumn[];
  maxRows?: number;
  wordingTags?: string[];
}

export type TFieldValue = string | string[] | Record<string, string | string[] | null>[];

export interface IFieldBasis {
  basisType: 'fragment' | 'decision' | 'requirement_revision' | 'evidence_fact';
  fragmentId: string | null;
  decisionId: string | null;
  requirementRevisionId: string | null;
  evidenceFactId: string | null;
  quote: string | null;
  text: string | null;
  origin: string | null;
  problem: string | null;
  problemText: string | null;
}

export type TFieldState = 'accepted' | 'edited' | 'needs_discussion' | 'cleared' | 'carried_over';
export type TFieldOrigin = 'manual' | 'approved_wording' | 'model_suggestion' | 'system_suggestion' | 'carried_over';

export interface IFieldVersion {
  id: string;
  version: number;
  value: TFieldValue | null;
  state: TFieldState;
  origin: TFieldOrigin;
  restricted: boolean;
  wording: { versionId: string; version: number; title: string; newerApproved: boolean } | null;
  suggestionId: string | null;
  previousVersionId: string | null;
  // Версия, значение которой повторено (обсуждение, подтверждение, перенос): права и происхождение — по ней.
  valueFromVersionId: string | null;
  comment: string | null;
  responsible: { id: string; name: string } | null;
  customerQuestionId: string | null;
  actor: { id: string; name: string };
  createdAt: string;
  bases: IFieldBasis[];
  invalidations: { reason: string; at: string }[];
  // Основание версии, значение которой повторено, заменено (обсуждение, перенос): копия тоже «устарела».
  inheritedProblem: { cause: string; text: string } | null;
  stale: boolean;
}

export interface IFieldSuggestion {
  id: string;
  status: 'open' | 'accepted' | 'rejected' | 'expired';
  value: TFieldValue | null;
  rationale: string | null;
  restricted: boolean;
  etag: string;
  evidence: { fragmentId: string; origin: string; quote: string | null; text: string | null }[];
}

export interface IFieldView {
  fieldId: string;
  key: string;
  definition: IFieldDefinition;
  applicable: boolean;
  required: boolean;
  version: number;
  etag: string;
  latest: IFieldVersion | null;
  systemProposals: { evidenceFactId: string; title: string; text: string | null; value: TFieldValue | null; restricted: boolean }[];
  conflictingFacts: { evidenceFactId: string; title: string }[];
  suggestions: IFieldSuggestion[];
}

export interface IFormIssue {
  kind: 'required_empty' | 'needs_discussion' | 'stale' | 'carried_over' | 'invalid_value' | 'constraint' | 'contradiction' | 'unverified';
  fieldKey: string | null;
  label: string;
  blocking: boolean;
  message: string;
}

export interface IDraftView {
  id: string;
  title: string;
  status: 'in_progress' | 'complete' | 'superseded';
  rowVersion: number;
  etag: string;
  tenderId: string;
  stageId: string;
  template: {
    id: string;
    name: string;
    ownerKind: 'company' | 'customer';
    isDemo: boolean;
    revisionId: string;
    revisionSeq: number;
    currentRevisionId: string | null;
    newerRevisionAvailable: boolean;
  };
  schemaTitle: string;
  migratedFromDraftId: string | null;
  migrationReport: IMigrationReport | null;
  supersededByDraftId: string | null;
  sections: { key: string; title: string; help: string | null; fields: IFieldView[] }[];
  issues: IFormIssue[];
  blocking: number;
  canFill?: boolean;
}

export interface IMigrationReport {
  carried: { key: string; label: string; changes: { kind: string; from: string; to: string }[] }[];
  dropped: { key: string; label: string; reason: string; detail: string }[];
  added: { key: string; label: string; required: boolean }[];
  droppedBases?: { key: string; cause: string }[];
}

export interface IDraftBrief {
  id: string;
  title: string;
  status: IDraftView['status'];
  isDemo: boolean;
  template: { id: string; name: string; ownerKind: string; revisionSeq: number; newerRevisionAvailable: boolean };
  filled: number;
  fields: number;
  blocking: number;
  etag: string;
  createdAt: string;
}

export interface ITemplateBrief {
  id: string;
  ownerKind: 'company' | 'customer';
  tenderId: string | null;
  name: string;
  isDemo: boolean;
  currentRevisionId: string | null;
  currentSeq: number | null;
  latestSeq: number | null;
  canManage: boolean;
}

export interface ITemplateRevision {
  id: string;
  templateId: string;
  templateName: string;
  isDemo: boolean;
  seq: number;
  status: 'draft' | 'approved' | 'retired';
  title: string;
  fieldCount: number;
  etag: string;
  createdAt: string;
  // Этап 12 (D-032 В-12-3): размеченная копия образца, формат, аудитория, итог проверки разметки.
  sample?: { sha256: string; name: string } | null;
  markedSample?: { sha256: string; name: string } | null;
  outputFormat?: 'docx' | 'xlsx' | null;
  audience?: 'customer' | 'internal';
  markup?: IMarkupResult | null;
}

export interface IMarkupResult {
  ok: boolean;
  format: 'docx' | 'xlsx';
  printed: string[];
  blocks: string[];
  loops: { key: string; columns: string[] }[];
  notPrinted: string[];
  tags: number;
  issues: { code: string; key: string | null; where: string | null; message: string }[];
}

export interface IWording {
  wordingId: string;
  scopeTenderId: string | null;
  title: string;
  versionId: string;
  version: number;
  text: string;
  tags: string[];
  status: 'proposed' | 'approved' | 'retired';
  proposedBy: { id: string; name: string };
  etag: string;
}

export interface ISuggestionRun {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'completed_with_gaps' | 'failed';
  coverage: Record<string, unknown>;
  createdAt: string;
}

export interface IStageIssues {
  items: { draftId: string; title: string; status: string; isDemo: boolean; blocking: number; issues: IFormIssue[] }[];
}

export type TFieldAction =
  | { action: 'set'; value: unknown; bases?: { type: 'fragment' | 'decision' | 'requirement_revision'; id: string }[] }
  | { action: 'choose_wording'; wordingVersionId: string }
  | { action: 'accept_fact'; evidenceFactId: string }
  | { action: 'confirm' }
  | { action: 'discuss'; comment: string; createQuestion: boolean; responsibleUserId?: string | null }
  | { action: 'clear' };
