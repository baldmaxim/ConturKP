import {parseArgs} from 'node:util';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {physicalPath} from '../../packages/storage/src/index.ts';
import {withinRoot} from '../lib/locus-registry-export.mjs';
import {evaluateReviewedAliases} from '../lib/locus-reviewed-aliases.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
try{
 const {values}=parseArgs({options:{...Object.fromEntries(['package','decisions','approval','locus','portal','out'].map(k=>[k,{type:'string'}])),'portal-root':{type:'string',multiple:true}},strict:true});
 if(['package','decisions','approval','locus','portal','out'].some(k=>!values[k])||!values['portal-root']?.length)throw new Error('ALIAS_USAGE');
 const inputs={},hashes={};for(const k of ['package','decisions','approval','locus','portal']){const raw=await readFile(values[k]);inputs[k]=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/u,''));hashes[k]=sha(raw);}
 const output=await physicalPath(resolve(values.out));
 for(const p of [...values['portal-root'],...(inputs.package.sourceSnapshots?.roots??[]).map(r=>r.path)]){const root=await physicalPath(p);if(withinRoot(root,output)||withinRoot(output,root))throw new Error('ALIAS_OUTPUT_OVERLAPS_SOURCE');}
 try{await lstat(output);throw new Error('ALIAS_OUTPUT_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
 const result=evaluateReviewedAliases({reviewPackage:inputs.package,decisions:inputs.decisions,approval:inputs.approval,decisionSha256:hashes.decisions,locus:inputs.locus,portal:inputs.portal});
 result.inputSha256=hashes;result.implementationSha256=sha(await readFile(new URL('../lib/locus-reviewed-aliases.mjs',import.meta.url)));
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({evaluation:result.evaluation,groups:result.groups.length,reviewedAliases:result.reviewedAliases,issues:result.issues,retirementAllowed:false}));
 if(result.evaluation!=='PASS')process.exitCode=2;
}catch(e){console.error(JSON.stringify({error:/^[A-Z][A-Z0-9_]+$/u.test(e?.message??'')?e.message:'ALIAS_IO_ERROR'}));process.exitCode=1;}
