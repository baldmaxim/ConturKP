// Этап 13 — ядро матрицы блокеров (D-033; packages/core/src/release/gate.ts): классы и снимаемость кодов, режимы,
// действие принятия риска (тот же пункт и версия предмета), учёт принятий в действующем согласовании при выпуске,
// пункт поля с другой проблемой не принимается; манифест выпуска — каноническая запись; устаревший вход прогона —
// неснимаемый (R13-01); отпечаток показанного состава (R13-04).
import { describe, expect, it } from 'vitest';
import {
  ACCEPTABLE_BLOCKERS,
  BLOCKERS,
  compositionHash,
  evaluateGate,
  openBlockerCodes,
  RELEASE_MANIFEST_SCHEMA,
  releaseManifestBytes,
  releaseManifestSha256,
  type IGateFacts,
  type IReleaseManifest,
  type IRiskAcceptanceFact,
} from '../packages/core/src/index.ts';

const base = (o: Partial<IGateFacts> = {}): IGateFacts => ({
  mode: 'test',
  actorAuthorized: true,
  actorSeesContent: true,
  approval: null,
  contentMismatch: [],
  reviewScopeMismatch: false,
  reviewOutdated: [],
  reviewMissing: false,
  reviewProcessing: [],
  uncoveredEvents: [],
  staleChannels: [],
  fieldsStale: [],
  calculationProvisional: true,
  templateDemo: true,
  kpTotalMissing: true,
  kpTotalUnreconciled: false,
  reviewUncertain: [],
  criticalFindings: [],
  questions: [],
  fieldsIncomplete: [],
  numbersUnverified: [],
  acceptances: [],
  ...o,
});

const acceptance = (o: Partial<IRiskAcceptanceFact>): IRiskAcceptanceFact => ({
  id: 'a1',
  blockerCode: 'CRITICAL_FINDINGS_OPEN',
  subjectType: 'finding',
  subjectId: 'f1',
  subjectKey: '',
  subjectVersion: 3,
  reason: 'принято',
  acceptedBy: 'Руководитель',
  acceptedAt: '2026-10-07T00:00:00.000Z',
  ...o,
});

describe('классы и снимаемость (D-033)', () => {
  it('снимаются риском только пять бизнес-кодов; технические, полномочия и целостность — нет', () => {
    expect([...ACCEPTABLE_BLOCKERS].sort()).toEqual(['CRITICAL_FINDINGS_OPEN', 'FIELDS_INCOMPLETE', 'NUMBERS_UNVERIFIED', 'QUESTIONS_UNANSWERED', 'REVIEW_UNCERTAIN']);
    for (const code of ['REVIEW_MISSING', 'REVIEW_PROCESSING_INCOMPLETE', 'FIELDS_STALE', 'KP_TOTAL_NOT_APPROVED', 'INTAKE_NOT_CURRENT', 'INPUTS_CHANGED'] as const) {
      expect(BLOCKERS[code]).toMatchObject({ class: 'integrity', acceptable: false });
    }
    expect(BLOCKERS.CANDIDATE_CONTENT_MISMATCH.class).toBe('technical');
    expect(BLOCKERS.APPROVAL_NOT_ACTIVE.class).toBe('authority');
  });

  it('боевые ограничения действуют только в боевом режиме (В-13-2)', () => {
    expect(evaluateGate(base(), 'approve')).toMatchObject({ ok: true, blockers: [] });
    expect(openBlockerCodes(evaluateGate(base({ mode: 'production' }), 'approve'))).toEqual(['CALCULATION_PROVISIONAL', 'TEMPLATE_DEMO', 'KP_TOTAL_NOT_APPROVED']);
  });
});

describe('принятие риска', () => {
  const finding = { subjectType: 'finding', subjectId: 'f1', subjectVersion: 3, title: 'Критическое замечание' };

  it('снимает пункт при той же версии предмета; изменённый предмет снова открыт (D-033 ут. 3)', () => {
    const ok = evaluateGate(base({ criticalFindings: [finding], acceptances: [acceptance({})] }), 'approve');
    expect(ok.ok).toBe(true);
    expect(ok.usedAcceptanceIds).toEqual(['a1']);
    const changed = evaluateGate(base({ criticalFindings: [{ ...finding, subjectVersion: 4 }], acceptances: [acceptance({})] }), 'approve');
    expect(openBlockerCodes(changed)).toEqual(['CRITICAL_FINDINGS_OPEN']);
    expect(changed.blockers[0]!.items[0]!.acceptance).toBeNull();
  });

  it('при выпуске принятие действует, только если учтено в действующем согласовании (В-13-3)', () => {
    const f = base({ criticalFindings: [finding], acceptances: [acceptance({})] });
    expect(evaluateGate({ ...f, approval: { active: true, matches: true, acceptedRiskIds: ['a1'] } }, 'release').ok).toBe(true);
    const late = evaluateGate({ ...f, approval: { active: true, matches: true, acceptedRiskIds: [] } }, 'release');
    expect(openBlockerCodes(late)).toEqual(['CRITICAL_FINDINGS_OPEN']);
    expect(openBlockerCodes(evaluateGate({ ...f, approval: { active: false, matches: false, acceptedRiskIds: ['a1'] } }, 'release'))).toEqual(['APPROVAL_NOT_ACTIVE']);
  });

  it('пункт поля с другой проблемой не принимается (D-033 ут. 2); неснимаемый блокер не снимается принятием', () => {
    const field = { subjectType: 'field_version', subjectId: 'v1', subjectKey: 'unverified', title: 'не сверено', acceptable: false };
    const r = evaluateGate(
      base({
        fieldsIncomplete: [field],
        fieldsStale: [{ subjectType: 'field_version', subjectId: 'v1', title: 'основание изменилось' }],
        acceptances: [acceptance({ id: 'a2', blockerCode: 'FIELDS_INCOMPLETE', subjectType: 'field_version', subjectId: 'v1', subjectKey: 'unverified', subjectVersion: null })],
      }),
      'approve',
    );
    expect(openBlockerCodes(r)).toEqual(['FIELDS_STALE', 'FIELDS_INCOMPLETE']);
  });

  it('содержимое не совпало, права, события — всегда блокируют', () => {
    const r = evaluateGate(base({ contentMismatch: ['01 Письмо.docx'], actorSeesContent: false, uncoveredEvents: [{ subjectType: 'stage_input_event', subjectId: 'e', title: '№ 5' }] }), 'approve');
    expect(openBlockerCodes(r)).toEqual(['RESTRICTED_INPUTS', 'CANDIDATE_CONTENT_MISMATCH', 'INPUTS_CHANGED']);
  });
});

describe('Review 13-1', () => {
  it('R13-01: устаревший вход прогона — технический неснимаемый блокер; принятие с тем же кодом его не снимает', () => {
    expect(BLOCKERS.REVIEW_OUTDATED).toMatchObject({ class: 'technical', acceptable: false });
    expect(ACCEPTABLE_BLOCKERS).not.toContain('REVIEW_OUTDATED');
    const item = { subjectType: 'review_run', subjectId: 'r1', title: 'после прогона изменился реестр' };
    const facts = base({ mode: 'test', reviewOutdated: [item], acceptances: [acceptance({ blockerCode: 'REVIEW_OUTDATED' as never, subjectType: 'review_run' as never, subjectId: 'r1', subjectVersion: null })] });
    for (const action of ['approve', 'release', 'send'] as const) {
      const g = evaluateGate({ ...facts, approval: action === 'approve' ? null : { active: true, matches: true, acceptedRiskIds: ['a1'] } }, action);
      expect(g.ok).toBe(false);
      expect(openBlockerCodes(g)).toEqual(['REVIEW_OUTDATED']);
      expect(g.usedAcceptanceIds).toEqual([]);
    }
  });

  it('R13-04: отпечаток состава не зависит от порядка и меняется с риском, решением по удержанию, риском этапа 09 и согласованием', () => {
    const f = {
      action: 'approve' as const,
      contentHash: 'c'.repeat(64),
      approvalId: null,
      acceptances: [{ id: 'a1', subjectVersion: 3 }, { id: 'a2', subjectVersion: null }],
      reviewRisks: [{ findingId: 'f9', acceptedAt: '2026-10-07T00:00:00.000Z' }],
      holds: [{ id: 'h1', status: 'resolved_not_applicable', decisionId: 'd1' }],
    };
    const h = compositionHash(f);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(compositionHash({ ...f, acceptances: [...f.acceptances].reverse() })).toBe(h);
    expect(compositionHash({ ...f, acceptances: [...f.acceptances, { id: 'a3', subjectVersion: 1 }] })).not.toBe(h);
    expect(compositionHash({ ...f, acceptances: [{ id: 'a1', subjectVersion: 4 }, f.acceptances[1]!] })).not.toBe(h);
    expect(compositionHash({ ...f, holds: [...f.holds, { id: 'h2', status: 'resolved_not_applicable', decisionId: 'd2' }] })).not.toBe(h);
    expect(compositionHash({ ...f, reviewRisks: [] })).not.toBe(h);
    expect(compositionHash({ ...f, action: 'release', approvalId: 'p1' })).not.toBe(compositionHash({ ...f, action: 'release', approvalId: 'p2' }));
  });
});

describe('манифест выпуска', () => {
  it('каноническая запись: порядок ключей не влияет на байты и SHA-256', () => {
    const m: IReleaseManifest = {
      schema: RELEASE_MANIFEST_SCHEMA,
      release: { id: 'r', mode: 'test', tenderId: 't', stageId: 's', inputVersion: 7, releasedBy: { id: 'u', name: 'Инженер' }, releasedAt: '2026-10-07T00:00:00.000Z' },
      candidate: { id: 'c', seq: 1, contentHash: 'h', marks: [] },
      approval: { id: 'a', approvedBy: { id: 'm', name: 'Руководитель' }, approvedAt: '2026-10-07T00:00:00.000Z', comment: null, inputVersion: 7, contentHash: 'h' },
      acceptedRisks: [],
      reviewRisks: [],
      holds: [],
      files: [{ path: '01 Письмо.docx', role: 'document', audience: 'customer', mediaType: 'application/x', sha256: 'f', size: 10 }],
    };
    const shuffled = JSON.parse(JSON.stringify({ files: m.files, holds: m.holds, schema: m.schema, approval: m.approval, candidate: m.candidate, release: m.release, reviewRisks: [], acceptedRisks: [] })) as IReleaseManifest;
    expect(releaseManifestBytes(shuffled).equals(releaseManifestBytes(m))).toBe(true);
    expect(releaseManifestSha256(shuffled)).toBe(releaseManifestSha256(m));
  });
});
