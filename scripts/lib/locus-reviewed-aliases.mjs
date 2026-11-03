// Evaluates exact aliases covered by a real owner review. Does not relax the legacy auditor,
// infer a source scope, change records, or accept the entire corpus/freeze/retirement.
import { validateReviewDecisions } from './locus-review-decisions.mjs';
export function evaluateReviewedAliases({ reviewPackage, decisions, approval, decisionSha256, locus, portal }) {
  const review = validateReviewDecisions({ reviewPackage, decisions, approval, decisionSha256 });
  const result = { schemaVersion: 1, evaluation: 'NOT_RUN', reviewedAliases: 0, groups: [], issues: [], retirementAllowed: false };
  if (!review.humanReviewed) { result.issues.push('OWNER_REVIEW_NOT_ACCEPTED'); return result; }
  if (locus?.schemaVersion !== 1 || locus.system !== 'locus' || portal?.schemaVersion !== 1 || portal.system !== 'portal' || !Array.isArray(locus.documents) || !Array.isArray(portal.documents)) throw new Error('INVALID_ALIAS_INVENTORY');
  if (review.reviewedCrosswalk.locusSnapshotId !== locus.snapshotId || review.reviewedCrosswalk.portalSnapshotId !== portal.snapshotId) {
    result.issues.push('SNAPSHOT_MISMATCH'); return result;
  }
  const sourceKey = d => JSON.stringify([d.sourceId, d.entryId]);
  const targetKey = d => JSON.stringify([d.documentId, d.revisionId]);
  const source = new Map(), target = new Map();
  for (const d of locus.documents) { const key=sourceKey(d); if(source.has(key))throw new Error('DUPLICATE_ALIAS_SOURCE'); source.set(key,d); }
  for (const d of portal.documents) { const key=targetKey(d); if(target.has(key))throw new Error('DUPLICATE_ALIAS_TARGET'); target.set(key,d); }
  const groups = Map.groupBy(review.reviewedCrosswalk.documents, targetKey);
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const t=target.get(key), issues=[];
    if (!t) issues.push('TARGET_MISSING');
    const scopes=new Set(members.map(m=>m.scopeId));
    if(scopes.size!==1)issues.push('CROSS_SCOPE_ALIAS');
    for (const m of members) {
      const s=source.get(sourceKey(m));
      if(!s){issues.push('SOURCE_MISSING');continue;}
      if(t&&t.scopeId!==m.scopeId)issues.push('TARGET_SCOPE_MISMATCH');
      if(!/^[a-f0-9]{64}$/u.test(s.sha256??'')||!t?.sha256||s.sha256!==t.sha256)issues.push('CONTENT_HASH_MISMATCH');
      if(!Number.isSafeInteger(s.bytes)||s.bytes<0||s.bytes!==t?.bytes)issues.push('CONTENT_SIZE_MISMATCH');
    }
    const uniqueIssues=[...new Set(issues)];
    result.groups.push({ documentId:members[0].documentId, revisionId:members[0].revisionId, scopeId:members[0].scopeId,
      sourceIdentities:members.map(m=>({sourceId:m.sourceId,entryId:m.entryId})), sha256:t?.sha256??null, bytes:t?.bytes??null, accepted:uniqueIssues.length===0, issues:uniqueIssues });
    result.issues.push(...uniqueIssues);
    if(!uniqueIssues.length)result.reviewedAliases+=members.length;
  }
  result.issues=[...new Set(result.issues)];
  result.evaluation=result.issues.length?'FAIL':'PASS';
  return result;
}
