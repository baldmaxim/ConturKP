// Схемы запросов и ответов API этапа 02 (docs/contracts/portal-api.md §2.1–2.2).
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));

export const ROLE = z.enum(['admin', 'manager', 'engineer']);
export const MEMBER_ROLE = z.enum(['engineer', 'manager']);
export const LOGIN = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/, 'логин: латиница, цифры, . _ -, от 2 символов');
const ISO_UTC = z.iso.datetime({ offset: true });

export const LoginRequest = z.object({ login: z.string().trim().toLowerCase().min(1).max(64), password: z.string().min(1).max(1024) }).strict();

export const ChangePasswordRequest = z
  .object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(12).max(1024) })
  .strict();

export const CreateUserRequest = z
  .object({
    login: LOGIN,
    displayName: text(200),
    roles: z.array(ROLE).min(1).max(3),
    password: z.string().min(12).max(1024),
  })
  .strict();

export const PatchUserRequest = z
  .object({
    displayName: text(200).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    roles: z.array(ROLE).max(3).optional(),
  })
  .strict();

export const ResetPasswordRequest = z.object({ password: z.string().min(12).max(1024) }).strict();

export const CreateTenderRequest = z
  .object({ code: text(64), title: text(500), customerName: optionalText(500), objectName: optionalText(500) })
  .strict();

export const PatchTenderRequest = z
  .object({
    title: text(500).optional(),
    customerName: optionalText(500),
    objectName: optionalText(500),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();

export const PutMemberRequest = z.object({ memberRole: MEMBER_ROLE }).strict();

export const CreateStageRequest = z
  .object({ title: text(500), submissionDeadline: ISO_UTC.nullable().optional() })
  .strict();

export const PatchStageRequest = z
  .object({ title: text(500).optional(), submissionDeadline: ISO_UTC.nullable().optional() })
  .strict();

export const AuditQuery = z.object({
  cursor: z.string().regex(/^\d{1,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---- источники (этап 03)

export const DOC_TYPE = z.enum(['tz', 'pd', 'rd', 'contract', 'boq', 'qa_form', 'letter', 'minutes', 'supplier_quote', 'other']);

export const PatchDocumentRequest = z
  .object({
    title: text(500).optional(),
    docType: DOC_TYPE.optional(),
    docCode: optionalText(100),
    scopeNote: optionalText(2000),
  })
  .strict();

export const ResolveImportItemRequest = z.discriminatedUnion('resolution', [
  z.object({ resolution: z.literal('reimported'), resolvedByItemId: z.uuid() }).strict(),
  z.object({ resolution: z.literal('not_applicable'), reason: z.string().trim().min(5).max(4000) }).strict(),
]);

export const CreateChannelRequest = z
  .object({
    origin: z.enum(['local', 'yandex_disk', 'smb']),
    locator: z.string().trim().min(1).max(1000),
    freshnessSeconds: z.number().int().min(60).max(7 * 86400).default(900),
    scanIntervalSeconds: z.number().int().min(5).max(86400).default(60),
  })
  .strict();

export const PatchChannelRequest = z
  .object({
    origin: z.enum(['local', 'yandex_disk', 'smb']).optional(),
    locator: z.string().trim().min(1).max(1000).optional(),
    freshnessSeconds: z.number().int().min(60).max(7 * 86400).optional(),
    scanIntervalSeconds: z.number().int().min(5).max(86400).optional(),
    active: z.boolean().optional(),
    disabledReason: z.string().trim().min(5).max(2000).optional(),
  })
  .strict();

export const PutSourceSetItemsRequest = z
  .object({
    items: z
      .array(
        z
          .object({
            documentRevisionId: z.uuid(),
            inclusion: z.enum(['included', 'excluded_not_applicable']),
            reason: z.string().trim().min(3).max(2000).nullable().optional(),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();

// ---- распознавание и доказательства (этап 04)

export const RECOGNITION_ENGINE = z.enum(['rdweb_export', 'rdweb_api', 'text_layer', 'local_ocr']);
export const RECOGNITION_STATUS = z.enum(['queued', 'running', 'complete', 'partial', 'failed', 'cancelled']);
export const RECOGNITION_PAGE_STATUS = z.enum(['recognized', 'missing', 'failed']);
export const FRAGMENT_ORIGIN = z.enum([
  'document_text',
  'recognized_text',
  'model_description',
  'negotiation_speech',
  'negotiation_hint',
  'email_body',
  'attachment_text',
]);
export const FRAGMENT_KIND = z.enum([
  'text_block',
  'image_block',
  'stamp_block',
  'unknown_block',
  'summary',
  'description',
  'entities',
  'verification',
  'unknown_section',
]);
export const BBOX_SPACE = z.enum(['page_unrotated', 'page_rotated']);

export const RecognitionFragmentsQuery = z.object({
  pageIndex: z.coerce.number().int().min(0).optional(),
  // Курсор выдаёт сам сервер: (page_index, ordinal, part_index, id). Части длинного текста
  // обязаны входить в ключ, иначе страницы выдачи пересекаются или теряются (R04-06, R04-07).
  // Четвёртый компонент — настоящий UUID, а не «36 символов из [0-9a-f-]»: иначе похожая,
  // но недопустимая строка доходила до `::uuid` в SQL и возвращала 500 вместо 400 (R04-16).
  cursor: z
    .string()
    .regex(/^-?\d{1,9}:-?\d{1,9}:-?\d{1,9}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// Заморозка состава: тело пустое, решение подтверждается If-Match и ключом идемпотентности.
export const FreezeSourceSetRequest = z.object({}).strict();

// ---- снимок области и поиск (этап 05)

// Снимок строится из замороженной ревизии набора этапа: по умолчанию — последней (state-machines §5.1).
export const CreateEvidenceScopeRequest = z.object({ sourceSetRevisionId: z.uuid().optional() }).strict();

// Контекст поиска — расширяемое объединение по виду (ADR-012 §24): tender реализован на этапе 05,
// contract зарезервирован для этапа 06a. Режимы release и comparison появятся с выпусками.
export const SearchContext = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tender'),
      tenderId: z.uuid(),
      mode: z.enum(['working', 'review', 'release', 'comparison']),
      stageId: z.uuid().optional(),
      evidenceScopeId: z.uuid().optional(),
      releaseId: z.uuid().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('contract'), contractId: z.uuid() }).strict(),
]);

export const SearchRequest = z
  .object({
    context: SearchContext,
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

// ---- договорной контур (этап 06a; D-017, D-022, D-023)

const DATE_ONLY = z.iso.date();

export const CreateContractRequest = z
  .object({ number: text(100), title: text(500), counterparty: optionalText(500), signedOn: DATE_ONLY.nullable().optional() })
  .strict();

export const PatchContractRequest = z
  .object({ number: text(100).optional(), title: text(500).optional(), counterparty: optionalText(500), signedOn: DATE_ONLY.nullable().optional() })
  .strict();

// Архив и возврат договора: тело пустое, версия — If-Match.
export const ContractStatusRequest = z.object({}).strict();

export const CONTRACT_CAPABILITY = z.enum(['contract.read', 'contract.link', 'contract.manage']);

// Полный набор действующих возможностей пользователя по договору: недостающие выдаются, лишние отзываются.
export const PutContractAccessRequest = z.object({ capabilities: z.array(CONTRACT_CAPABILITY).max(3) }).strict();

export const CreateContractLinkRequest = z.object({ tenderId: z.uuid(), stageId: z.uuid().nullable().optional(), note: optionalText(500) }).strict();

export const PatchContractLinkRequest = z.object({ stageId: z.uuid().nullable().optional(), note: optionalText(500) }).strict();

export const ArchiveContractLinkRequest = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const CONTRACT_ROLE = z.enum(['contract', 'addendum', 'appendix']);

// Параметры загрузки документа договора в строке запроса; имя файла — параметр name (как у импорта).
export const ContractDocumentUploadQuery = z.object({
  role: CONTRACT_ROLE,
  mainDocumentId: z.uuid().optional(),
  title: z.string().trim().min(1).max(500).optional(),
});

export const PatchContractDocumentRequest = z.object({ title: text(500) }).strict();

// ---- ответы

export interface IMe {
  id: string;
  login: string;
  displayName: string;
  roles: string[];
  // Глобальные возможности; contract.create — только при действующей выдаче (D-022 OD-2).
  capabilities: string[];
  memberships: { tenderId: string; memberRole: string }[];
  // Раздел «Договоры» доступен: администратор договоров, выдача contract.create или любая выдача по договору.
  contractsAvailable: boolean;
}

export interface IUser {
  id: string;
  login: string;
  displayName: string;
  status: 'active' | 'disabled';
  roles: string[];
  rowVersion: number;
  createdAt: string;
}

export interface ITender {
  id: string;
  code: string;
  title: string;
  customerName: string | null;
  objectName: string | null;
  status: 'active' | 'archived';
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  myRole: 'engineer' | 'manager' | null;
  capabilities: string[];
}

export interface IMember {
  userId: string;
  login: string;
  displayName: string;
  memberRole: 'engineer' | 'manager';
  assignedAt: string;
  assignedBy: { id: string; displayName: string } | null;
}

export interface IStage {
  id: string;
  tenderId: string;
  seq: number;
  title: string;
  submissionDeadline: string | null;
  status: 'active' | 'archived';
  inputVersion: number;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface IAuditEvent {
  id: string;
  occurredAt: string;
  actor: { id: string; login: string; displayName: string } | null;
  principalKind: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  outcome: 'allowed' | 'denied' | 'failed';
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------- Расчёт TenderHub (этап 06, portal-api §2.5)

// Связь этапа с тендером TenderHub (Q-03): id строки tenders TenderHub — каждая версия отдельной строкой.
export const PutCalculationSourceRequest = z
  .object({
    externalTenderId: z.uuid(),
    externalVersion: z.number().int().min(0).max(1_000_000).nullable().optional(),
  })
  .strict();

export const CreateCalculationCaptureRequest = z.object({}).strict();

const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// Курсоры выдаёт сервер; проверка строгая, чтобы похожая, но недопустимая строка не дошла до SQL (R04-16).
export const CalculationPositionsQuery = z.object({
  cursor: z
    .string()
    .regex(new RegExp(`^-?\\d{1,40}(?:\\.\\d{1,40})?:${UUID_TEXT}$`))
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const CalculationLinesQuery = z.object({
  positionId: z.uuid().optional(),
  cursor: z
    .string()
    .regex(new RegExp(`^${UUID_TEXT}:-?\\d{1,10}:${UUID_TEXT}$`))
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// Решения человека по сопоставлению позиций между ревизиями (append-only; этап 10 разбирает экономику).
export const AppendLineageRequest = z
  .object({
    fromRevisionId: z.uuid(),
    links: z
      .array(
        z
          .object({
            fromPositionId: z.uuid(),
            toPositionId: z.uuid(),
            status: z.enum(['confirmed', 'rejected']),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PRECONDITION_REQUIRED'
  | 'VERSION_CONFLICT'
  | 'STATE_CONFLICT'
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface IProblem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  requestId: string;
  current?: unknown;
  errors?: { path: string; message: string }[];
}
