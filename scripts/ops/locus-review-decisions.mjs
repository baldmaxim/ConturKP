import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { physicalPath } from '../../packages/storage/src/index.ts';
import { withinRoot } from '../lib/locus-registry-export.mjs';
import { createReviewPackage, createDecisionTemplate, validateReviewDecisions, reconcileReviewDecisions } from '../lib/locus-review-decisions.mjs';
import { renderDecisionForm } from '../lib/locus-review-form.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
try {
  const names = ['report','file-review','package','previous-package','decisions','approval','out','out-dir'];
  const { values, positionals } = parseArgs({ options: { ...Object.fromEntries(names.map(k => [k,{type:'string'}])), 'portal-root':{type:'string',multiple:true} }, allowPositionals:true, strict:true });
  const action = positionals[0];
  const required = { prepare:['report','file-review','out-dir'], validate:['package','decisions','out'], reconcile:['previous-package','package','decisions','out'] }[action];
  if(positionals.length!==1 || !required || required.some(k=>!values[k]) || !values['portal-root']?.length) throw Error('DECISIONS_USAGE');
  const data={}, inputSha256={};
  for(const key of names.filter(k=>values[k]&&!['out','out-dir'].includes(k))){const raw=await readFile(values[key]);data[key]=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/u,''));inputSha256[key]=sha(raw);}
  const output=await physicalPath(resolve(values['out-dir']??values.out));
  const roots=[...values['portal-root'],...(data['file-review']?.roots??data.package?.sourceSnapshots?.roots??[]).map(r=>r.path)];
  for(const path of roots){const root=await physicalPath(path);if(withinRoot(root,output)||withinRoot(output,root))throw Error('DECISIONS_OUTPUT_OVERLAPS_SOURCE');}
  try{await lstat(output);throw Error('DECISIONS_OUTPUT_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(action==='prepare'){
    const pkg=createReviewPackage({report:data.report,fileReview:data['file-review']}), template=createDecisionTemplate(pkg);
    await mkdir(output);
    const files={'review-package.private.json':json(pkg),'decisions-template.private.json':json(template),'decision-form.private.html':renderDecisionForm(pkg),
      'approval-template.private.json':json({kind:'OWNER_REVIEW_APPROVAL',reviewPackageId:pkg.packageId,decisionSha256:null,owner:null,approvedAt:null,evidenceRef:null})};
    for(const [name,raw] of Object.entries(files))await writeFile(resolve(output,name),raw,{flag:'wx'});
    await writeFile(resolve(output,'receipt.private.json'),json({inputSha256,packageId:pkg.packageId,registry:pkg.registry.length,files:pkg.files.length,groups:pkg.groups.length,outputSha256:Object.fromEntries(Object.entries(files).map(([k,v])=>[k,sha(v)])),humanReviewed:false,retirementAllowed:false}),{flag:'wx'});
    console.log(json({packageId:pkg.packageId,registry:pkg.registry.length,files:pkg.files.length,groups:pkg.groups.length,humanReviewed:false}).trim());
  }else{
    const result=action==='validate'?validateReviewDecisions({reviewPackage:data.package,decisions:data.decisions,approval:data.approval??null,decisionSha256:inputSha256.decisions}):
      reconcileReviewDecisions({previousPackage:data['previous-package'],nextPackage:data.package,decisions:data.decisions});
    await writeFile(output,json(result),{flag:'wx'});
    console.log(json({action,humanReviewed:result.humanReviewed,coverageComplete:result.coverageComplete,missing:result.missing?.length,retirementAllowed:false}).trim());
    if(action==='validate'&&!result.humanReviewed)process.exitCode=2;
  }
}catch(error){console.error(JSON.stringify({error:/^[A-Z][A-Z0-9_]+$/u.test(error?.message??'')?error.message:'DECISIONS_IO_ERROR'}));process.exitCode=1;}
