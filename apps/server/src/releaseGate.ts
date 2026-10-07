// Оценка матрицы блокеров кандидата (этап 13; D-033; проект §5): факты слоя БД, права действующего пользователя,
// сверка точных байтов файлов и манифеста с хранилищем (только в командах — не в карточке) и бизнес-пробелы
// необязательных полей («не сверено» списка незавершённых, толкование D-033). Решение — evaluateGate ядра.
import { stat } from 'node:fs/promises';
import { allFields, applicability, evaluateGate, type FieldValue, type GateAction, type IGateFacts, type IGateItem, type IGateResult } from '@kontur/core';
import {
  acceptanceFact,
  candidateFiles,
  candidateGateDbFacts,
  candidateInputs,
  findingEvidence,
  getDraft,
  listAcceptances,
  stageVisibility,
  type IAccessContext,
  type IApprovalRow,
  type ICandidateGateDbFacts,
  type IReleaseCandidateRow,
  type Queryable,
} from '@kontur/db';
import type { BlobStore } from '@kontur/storage';
import { issuesForDraft } from './formsView.ts';
import { reviewVisibility } from './reviewMappers.ts';

// Байты файла хранилища совпадают с записанными SHA-256 и размером (ADR-003 §7): отсутствие файла — несовпадение.
export const blobIntact = async (store: BlobStore, sha256: string, size: number | null): Promise<boolean> => {
  try {
    if (size !== null && (await stat(store.pathOf(sha256))).size !== size) return false;
    return await store.verify(sha256);
  } catch {
    return false;
  }
};

// Пути файлов кандидата (и манифеста), байты которых в хранилище не совпадают с кандидатом.
export const verifyCandidateContent = async (db: Queryable, store: BlobStore, c: IReleaseCandidateRow): Promise<string[]> => {
  const broken: string[] = [];
  for (const f of await candidateFiles(db, c.id)) if (!(await blobIntact(store, f.blob_sha256, f.size_bytes))) broken.push(f.path);
  if (!c.manifest_blob_sha256 || c.manifest_blob_sha256 !== c.manifest_sha256 || !(await blobIntact(store, c.manifest_blob_sha256, null))) broken.push('manifest.json');
  return broken;
};

interface IPinnedVersion {
  id: string;
  draft_id: string;
  field_key: string;
  value: FieldValue | null;
  state: string;
}

const pinnedVersions = async (db: Queryable, candidateId: string): Promise<IPinnedVersion[]> =>
  (
    await db.query<IPinnedVersion>(
      `SELECT v.id, v.draft_id, f.field_key, v.value, v.state FROM candidate_input ci JOIN draft_field_version v ON v.id = ci.ref_id JOIN draft_field f ON f.id = v.field_id
        WHERE ci.candidate_id = $1 AND ci.kind = 'field_version'`,
      [candidateId],
    )
  ).rows;

export interface IFieldGaps {
  // Бизнес-пробелы: «не сверено» по полю закреплённой версии; принять риск — только если у поля нет других проблем.
  incomplete: IGateItem[];
  // Справка: применимые необязательные поля, оставленные пустыми (не пробел, D-033 толкование исполнителя).
  emptyOptional: { draftTitle: string; fieldKey: string; label: string }[];
}

export const fieldGaps = async (db: Queryable, ctx: IAccessContext, c: IReleaseCandidateRow, staleVersionIds: ReadonlySet<string>): Promise<IFieldGaps> => {
  const pinned = await pinnedVersions(db, c.id);
  const draftIds = (await candidateInputs(db, c.id)).filter((i) => i.kind === 'application_draft').sort((a, b) => a.ordinal - b.ordinal).map((i) => i.ref_id);
  const incomplete: IGateItem[] = [];
  const emptyOptional: IFieldGaps['emptyOptional'] = [];
  for (const id of draftIds) {
    const draft = await getDraft(db, id);
    if (!draft) continue;
    const mine = pinned.filter((v) => v.draft_id === id);
    for (const issue of (await issuesForDraft(db, ctx, draft)).issues) {
      if (issue.kind !== 'unverified' || !issue.fieldKey) continue;
      const v = mine.find((x) => x.field_key === issue.fieldKey);
      if (!v) continue;
      incomplete.push({
        subjectType: 'field_version',
        subjectId: v.id,
        subjectKey: 'unverified',
        title: `«${draft.title}», ${issue.label}: ${issue.message}`,
        acceptable: !staleVersionIds.has(v.id),
      });
    }
    const values = new Map<string, FieldValue | null>(mine.map((v) => [v.field_key, v.state === 'cleared' ? null : v.value]));
    const app = applicability(draft.field_schema, { get: (k: string) => values.get(k) ?? null });
    for (const f of allFields(draft.field_schema)) {
      if (app.applicable.has(f.key) && !app.required.has(f.key) && (values.get(f.key) ?? null) === null) emptyOptional.push({ draftTitle: draft.title, fieldKey: f.key, label: f.label });
    }
  }
  return { incomplete, emptyOptional };
};

export interface ICandidateGate {
  result: IGateResult;
  db: ICandidateGateDbFacts;
  fields: IFieldGaps;
}

export interface IGateOptions {
  action: GateAction;
  actorAuthorized: boolean;
  actorSeesContent: boolean;
  // Выпуск: действующее согласование и совпадение запроса с ним (approvalId, хэш); null — карточка без запроса.
  approval?: { active: IApprovalRow | null; requestedId: string | null } | null;
  // Сверить байты файлов с хранилищем (команды согласования и выпуска).
  store?: BlobStore | null;
}

// Пункты замечаний и вопросов, закрытые пользователю (основания из чужого ящика, закрытое требование), показываются без
// текста (как в этапе 09, R08-02); принять риск по такому пункту нельзя — команда отвечает `restricted_fragments`.
const RESTRICTED_FINDING = 'Критическое замечание: основания закрыты для вас';
const RESTRICTED_QUESTION = 'Вопрос заказчику: закрыт для вас';

const maskRestricted = async (db: Queryable, ctx: IAccessContext, c: IReleaseCandidateRow, facts: ICandidateGateDbFacts): Promise<ICandidateGateDbFacts> => {
  const findingIds = [...facts.criticalFindings.map((f) => f.subjectId), ...facts.reviewRisks.map((r) => r.findingId)];
  const review = await reviewVisibility(db, ctx, c.stage_id, findingIds.length ? await findingEvidence(db, findingIds) : []);
  const stage = await stageVisibility(db, ctx, c.stage_id);
  const finding = (i: IGateItem): IGateItem => (review.finding(i.subjectId) ? i : { ...i, title: RESTRICTED_FINDING, restricted: true });
  const question = (i: IGateItem): IGateItem => (stage.visible('question', i.subjectId) ? i : { ...i, title: RESTRICTED_QUESTION, restricted: true });
  return {
    ...facts,
    criticalFindings: facts.criticalFindings.map(finding),
    questions: facts.questions.map(question),
    draftQuestions: facts.draftQuestions.map(question),
    reviewRisks: facts.reviewRisks.map((r) => (review.finding(r.findingId) ? r : { ...r, title: RESTRICTED_FINDING, reason: '' })),
  };
};

export const candidateGate = async (db: Queryable, ctx: IAccessContext, c: IReleaseCandidateRow, o: IGateOptions): Promise<ICandidateGate> => {
  const facts = await maskRestricted(db, ctx, c, await candidateGateDbFacts(db, c));
  const fields = await fieldGaps(db, ctx, c, new Set(facts.fieldsStale.map((x) => x.subjectId)));
  const active = o.approval?.active ?? null;
  const gateFacts: IGateFacts = {
    mode: c.mode,
    actorAuthorized: o.actorAuthorized,
    actorSeesContent: o.actorSeesContent,
    approval:
      o.action === 'approve'
        ? null
        : {
            active: active !== null,
            matches:
              active !== null && active.candidate_content_hash === c.manifest_sha256 && (o.approval?.requestedId === null || o.approval?.requestedId === undefined || o.approval.requestedId === active.id),
            acceptedRiskIds: active?.accepted_risk_ids ?? [],
          },
    contentMismatch: o.store ? await verifyCandidateContent(db, o.store, c) : null,
    reviewScopeMismatch: facts.reviewScopeMismatch,
    reviewMissing: facts.reviewMissing,
    reviewProcessing: facts.reviewProcessing,
    uncoveredEvents: facts.uncoveredEvents,
    staleChannels: facts.staleChannels,
    fieldsStale: facts.fieldsStale,
    calculationProvisional: facts.calculationProvisional,
    templateDemo: facts.templateDemo,
    kpTotalMissing: facts.kpTotalMissing,
    reviewUncertain: facts.reviewUncertain,
    criticalFindings: facts.criticalFindings,
    questions: facts.questions,
    fieldsIncomplete: fields.incomplete,
    numbersUnverified: facts.numbersUnverified,
    acceptances: (await listAcceptances(db, c.id)).map(acceptanceFact),
  };
  return { result: evaluateGate(gateFacts, o.action), db: facts, fields };
};
