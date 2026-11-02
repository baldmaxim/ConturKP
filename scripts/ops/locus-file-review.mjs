import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { physicalPath } from '../../packages/storage/src/index.ts';
import { withinRoot } from '../lib/locus-registry-export.mjs';
import { buildFileReview } from '../lib/locus-file-review.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
try{
 const {values}=parseArgs({options:{walk:{type:'string'},'active-walk':{type:'string'},unindexed:{type:'string'},'folder-depth':{type:'string'},'out-dir':{type:'string'},'portal-root':{type:'string',multiple:true}},strict:true});
 if(!values.walk||!values.unindexed||!values['out-dir']||!values['portal-root']?.length)throw Error('FILE_REVIEW_USAGE');
 const data={},inputSha256={};
 for(const k of ['walk','active-walk','unindexed'])if(values[k]){const raw=await readFile(values[k]);data[k]=JSON.parse(raw.toString('utf8'));inputSha256[k]=sha(raw);}
 let walk=data.walk;
 if(data['active-walk']){
  const current=data['active-walk'],ids=new Set(current.roots.map(r=>r.rootId));
  for(const root of current.roots)if(root.kind!=='data_metadata'||!walk.roots.some(r=>r.rootId===root.rootId&&r.path===root.path))throw Error('ACTIVE_DATA_ROOT_MISMATCH');
  walk={...walk,entries:[...walk.entries.filter(e=>!ids.has(e.rootId)),...current.entries],errors:[...walk.errors.filter(e=>!ids.has(e.rootId)),...current.errors],complete:false,purpose:'MIXED_DATE_REVIEW_INPUTS_NOT_FROZEN_PAIR'};
 }
 const output=await physicalPath(resolve(values['out-dir']));
 for(const p of [...values['portal-root'],...walk.roots.map(r=>r.path)]){const root=await physicalPath(p);if(withinRoot(root,output)||withinRoot(output,root))throw Error('FILE_REVIEW_OUTPUT_OVERLAP');}
 const review=buildFileReview({walk,unindexedFiles:data.unindexed.files,folderDepth:values['folder-depth']===undefined?1:Number(values['folder-depth']),inputSha256});
 await mkdir(output);
 await writeFile(resolve(output,'file-review.private.json'),JSON.stringify(review,null,2)+'\n',{flag:'wx'});
 await writeFile(resolve(output,'census.private.json'),JSON.stringify({inputSha256,statistics:review.statistics,census:review.census,groups:review.groups.map(({memberPaths,...g})=>({...g,files:memberPaths.length}))},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({...review.statistics,ownerDecisionsApplied:false,retirementAllowed:false}));
}catch(e){console.error(JSON.stringify({error:/^[A-Z][A-Z0-9_]+$/u.test(e?.message??'')?e.message:'FILE_REVIEW_IO_ERROR'}));process.exitCode=1;}
