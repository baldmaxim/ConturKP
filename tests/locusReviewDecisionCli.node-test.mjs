import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync,existsSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createReviewPackage,createDecisionTemplate} from '../scripts/lib/locus-review-decisions.mjs';
import {renderDecisionForm} from '../scripts/lib/locus-review-form.mjs';
function report(){
 return {locusSnapshotId:'l',portalSnapshotId:'p',rows:[{sourceId:'s',entryId:'a',classification:'SOURCE_NOT_HASHED',originalPath:'/source/$&</script>.pdf',sha256:null,bytes:null,targets:[],originalCandidates:[]},{sourceId:'s',entryId:'b',classification:'SOURCE_NOT_HASHED',originalPath:'/source/b.pdf',sha256:null,bytes:null,targets:[],originalCandidates:[]}]};
}
test('editable form exports a draft without dropping filtered identities or interpreting document markup',async()=>{
 const pkg=createReviewPackage({report:report()}),html=renderDecisionForm(pkg);
 const raw=/<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)[1],data=JSON.parse(raw);
 assert(data.registry[0].info.includes('$&</script>.pdf'));
 class Element{constructor(){this.children=[];this.value='';this.textContent='';}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=[...x];}click(){this.onclick?.();}}
 const ids=new Map();for(const match of html.matchAll(/id="([^"]+)"/gu))ids.set(match[1],new Element());
 ids.get('data').textContent=raw;ids.get('kind').value='registry';
 let blob;
 const context={document:{getElementById:id=>ids.get(id),createElement:()=>new Element()},Blob,URL:{createObjectURL:b=>{blob=b;return 'blob:fixture';},revokeObjectURL:()=>{}},setTimeout:fn=>fn(),alert:message=>{throw Error(message);}};
 const script=/<script>([\s\S]*?)<\/script>/.exec(html)[1];
 vm.runInNewContext(script,context);
 assert.equal(ids.get('rows').children.length,2);
 const row=ids.get('rows').children[0],action=row.children[1].children[0],reason=row.children[2].children[0];
 action.value='WITHDRAW';action.onchange();reason.value='Owner fixture retirement';reason.oninput();
 ids.get('filter').value='b.pdf';ids.get('filter').oninput();assert.equal(ids.get('rows').children.length,1);
 ids.get('owner').value='Fixture';ids.get('at').value='2026-11-02T10:00';ids.get('save').click();
 const draft=JSON.parse(await blob.text());assert.equal(draft.registry.length,2);assert.equal(draft.registry[0].action,'WITHDRAW');assert.equal(draft.registry[1].action,null);assert.equal(draft.reviewPackageId,pkg.packageId);
});
test('CLI creates package/template/form and never treats the empty template as human review',t=>{
 const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'kontur-review-decisions-'));
 t.after(()=>{assert.equal(dirname(realpathSync(dir)),parent);assert(basename(dir).startsWith('kontur-review-decisions-'));rmSync(dir,{recursive:true,force:true});});
 const reportFile=join(dir,'report.json'),files=join(dir,'files.json'),out=join(dir,'prepared'),portal=join(dir,'portal');mkdirSync(portal);
 writeFileSync(reportFile,JSON.stringify(report()));writeFileSync(files,JSON.stringify({units:[],groups:[]}));
 const cli='scripts/ops/locus-review-decisions.mjs',run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
 let r=run(['prepare','--report',reportFile,'--file-review',files,'--out-dir',out,'--portal-root',portal]);assert.equal(r.status,0,r.stderr);
 const result=join(dir,'validated.json');
 r=run(['validate','--package',join(out,'review-package.private.json'),'--decisions',join(out,'decisions-template.private.json'),'--out',result,'--portal-root',portal]);
 assert.equal(r.status,2,r.stderr);const v=JSON.parse(readFileSync(result,'utf8'));assert.equal(v.humanReviewed,false);assert.equal(v.missing.length,2);
 const bad=join(portal,'bad');r=run(['prepare','--report',reportFile,'--file-review',files,'--out-dir',bad,'--portal-root',portal]);assert.equal(r.status,1);assert.equal(existsSync(bad),false);
});

test('CLI accepts UTF-8 BOM in package, decisions and approval while hashing the exact decision bytes',t=>{
 const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'kontur-review-bom-'));
 t.after(()=>{assert.equal(dirname(realpathSync(dir)),parent);assert(basename(dir).startsWith('kontur-review-bom-'));rmSync(dir,{recursive:true,force:true});});
 const pkg=createReviewPackage({report:report()}),decisions=createDecisionTemplate(pkg);
 decisions.owner={name:'Fixture',decidedAt:'2026-11-02T10:00:00Z'};
 for(const d of decisions.registry)Object.assign(d,{action:'WITHDRAW',reason:'Fixture owner retirement'});
 const raw='\uFEFF'+JSON.stringify(decisions),hash=createHash('sha256').update(raw).digest('hex');
 const approval={kind:'OWNER_REVIEW_APPROVAL',reviewPackageId:pkg.packageId,decisionSha256:hash,owner:'Fixture',approvedAt:'2026-11-02T10:01:00Z',evidenceRef:'owner:fixture'};
 for(const [name,value] of Object.entries({package:pkg,decisions,approval}))writeFileSync(join(dir,name+'.json'),'\uFEFF'+JSON.stringify(value));
 const portal=join(dir,'portal');mkdirSync(portal);const out=join(dir,'validation.json');
 const r=spawnSync(process.execPath,['scripts/ops/locus-review-decisions.mjs','validate','--package',join(dir,'package.json'),'--decisions',join(dir,'decisions.json'),'--approval',join(dir,'approval.json'),'--out',out,'--portal-root',portal],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(readFileSync(out,'utf8')).humanReviewed,true);
});
