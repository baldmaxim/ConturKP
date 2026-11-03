import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReviewPackage,createDecisionTemplate } from '../scripts/lib/locus-review-decisions.mjs';
import { evaluateReviewedAliases } from '../scripts/lib/locus-reviewed-aliases.mjs';
import { auditLocusCorpus } from '../scripts/lib/locus-corpus-audit.mjs';
const hash='a'.repeat(64);
function fixture(){
 const target={scopeId:'scope',documentId:'doc',revisionId:'rev',inOwnScope:true,sha256:hash,bytes:12};
 const rows=['a','b'].map(entryId=>({sourceId:'src',entryId,scope:{id:'scope'},sha256:hash,bytes:12,targets:[target]}));
 const reviewPackage=createReviewPackage({report:{rows,locusSnapshotId:'ls',portalSnapshotId:'ps'}});
 const decisions=createDecisionTemplate(reviewPackage);decisions.owner={name:'Synthetic owner',decidedAt:'2026-11-03T09:00:00.000Z'};
 for(const d of decisions.registry){d.action='ACCEPT_MATCH';d.reason='Exact synthetic alias reviewed';d.targetFingerprint=reviewPackage.registry.find(r=>r.itemId===d.itemId).targets[0].fingerprint;}
 const decisionSha256=createHash('sha256').update(JSON.stringify(decisions)).digest('hex');
 const approval={kind:'OWNER_REVIEW_APPROVAL',reviewPackageId:reviewPackage.packageId,decisionSha256,owner:decisions.owner.name,approvedAt:'2026-11-03T09:01:00.000Z',evidenceRef:'synthetic-test-only'};
 return {reviewPackage,decisions,approval,decisionSha256,locus:{schemaVersion:1,system:'locus',snapshotId:'ls',documents:rows.map(r=>({sourceId:r.sourceId,entryId:r.entryId,sha256:hash,bytes:12}))},portal:{schemaVersion:1,system:'portal',snapshotId:'ps',documents:[target]}};
}
test('accepts only exact reviewed same-scope aliases without accepting retirement',()=>{const r=evaluateReviewedAliases(fixture());assert.equal(r.evaluation,'PASS');assert.equal(r.reviewedAliases,2);assert.equal(r.groups.length,1);assert.equal(r.retirementAllowed,false);});
test('does not accept a draft or a stale approval hash',()=>{for(const update of [x=>x.approval=null,x=>x.approval.decisionSha256='b'.repeat(64)]){const f=fixture();update(f);assert.equal(evaluateReviewedAliases(f).evaluation,'NOT_RUN');}});
test('rejects a changed snapshot',()=>{const f=fixture();f.portal.snapshotId='other';assert.deepEqual(evaluateReviewedAliases(f).issues,['SNAPSHOT_MISMATCH']);});
test('rejects equal bytes mapped to a foreign contract',()=>{const f=fixture();f.portal.documents[0]={...f.portal.documents[0],scopeId:'foreign'};const r=evaluateReviewedAliases(f);assert.equal(r.evaluation,'FAIL');assert.ok(r.issues.includes('TARGET_SCOPE_MISMATCH'));});
test('rejects changed hash, size, or missing source',()=>{for(const update of [f=>f.locus.documents[0].sha256='c'.repeat(64),f=>f.locus.documents[0].bytes=13,f=>f.locus.documents.pop()]){const f=fixture();update(f);assert.equal(evaluateReviewedAliases(f).evaluation,'FAIL');}});
test('rejects missing and duplicate target identities',()=>{const f=fixture();f.portal.documents=[];assert.equal(evaluateReviewedAliases(f).evaluation,'FAIL');const g=fixture();g.portal.documents.push({...g.portal.documents[0]});assert.throws(()=>evaluateReviewedAliases(g),/DUPLICATE_ALIAS_TARGET/u);});
test('leaves the legacy TARGET_REUSED rejection unchanged',()=>{const f=fixture();for(const i of [f.locus,f.portal])Object.assign(i,{capturedAt:'2026-11-03T09:02:00.000Z',complete:true,errors:[]});const crosswalk={schemaVersion:2,locusSnapshotId:'ls',portalSnapshotId:'ps',scopes:[],documents:f.reviewPackage.registry.map(r=>({sourceId:r.row.sourceId,entryId:r.row.entryId,scopeId:'scope',documentId:'doc',revisionId:'rev'}))};assert.ok(auditLocusCorpus({locus:f.locus,portal:f.portal,crosswalk}).issues.some(i=>i.code==='TARGET_REUSED'));assert.equal(evaluateReviewedAliases(f).evaluation,'PASS');});
