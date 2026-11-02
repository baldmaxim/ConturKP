// Measurements only. Does not create an isolation directory, cluster, roles, or copy files.
import {parseArgs} from 'node:util';
import {readFile,writeFile,statfs} from 'node:fs/promises';
import {dirname,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {physicalPath} from '../../packages/storage/src/index.ts';
import {withinRoot} from '../lib/locus-registry-export.mjs';
import {isolationCapacity,assertIsolationLayout} from '../lib/locus-isolation-capacity.mjs';
try{
 const {values}=parseArgs({options:{manifest:{type:'string'},target:{type:'string'},'planned-import-bytes':{type:'string'},'ocr-reserve-bytes':{type:'string'},out:{type:'string'},'portal-root':{type:'string',multiple:true}},strict:true});
 if(!values.manifest||!values.target||!values.out||!values['portal-root']?.length||!isAbsolute(values.target)||values['planned-import-bytes']===undefined||values['ocr-reserve-bytes']===undefined)throw Error('ISOLATION_PREFLIGHT_USAGE');
 if(!process.env.BACKUP_DATABASE_URL)throw Error('READ_ONLY_BACKUP_URL_REQUIRED');
 const target=await physicalPath(values.target),output=await physicalPath(resolve(values.out));
 for(const p of values['portal-root']){const root=await physicalPath(p);if(withinRoot(root,target)||withinRoot(target,root)||withinRoot(root,output))throw Error('ISOLATION_TARGET_OVERLAPS_PORTAL');}
 const raw=await readFile(values.manifest),manifest=JSON.parse(raw.toString('utf8'));
 const client=new pg.Client({connectionString:process.env.BACKUP_DATABASE_URL,application_name:'kontur-stage19a-capacity-readonly'});
 let databaseBytes;
 await client.connect();
 try{
  await client.query('BEGIN READ ONLY');
  const r=await client.query('SELECT current_user AS role, pg_database_size(current_database())::text AS bytes');
  if(r.rows[0].role!=='kontur_backup')throw Error('READ_ONLY_BACKUP_ROLE_REQUIRED');
  databaseBytes=Number(r.rows[0].bytes);
  await client.query('ROLLBACK');
 }finally{await client.end();}
 let ancestor=target,s;
 while(true){try{s=await statfs(ancestor);break;}catch(e){if(e.code!=='ENOENT'||dirname(ancestor)===ancestor)throw e;ancestor=dirname(ancestor);}}
 const capacity=isolationCapacity({freeBytes:s.bavail*s.bsize,backupFilesBytes:manifest.files.totalBytes,databaseBytes,plannedImportBytes:Number(values['planned-import-bytes']),ocrReserveBytes:Number(values['ocr-reserve-bytes'])});
 const layout=await assertIsolationLayout({targetRoot:target,clusterDataDir:resolve(target,'postgres-data'),storageRoot:resolve(target,'storage')});
 const report={...layout,schemaVersion:1,purpose:'READ_ONLY_CAPACITY_MEASUREMENT_NOT_RESTORE_PERMISSION',measuredAt:new Date().toISOString(),targetRoot:target,clusterDataDir:resolve(target,'postgres-data'),manifestSha256:createHash('sha256').update(raw).digest('hex'),...capacity,
  databaseBytesMethod:'pg_database_size_CURRENT_LIVE_DB_CONSERVATIVE_UPPER_INPUT_NOT_COMPRESSED_DUMP',servicesChanged:false,restoreStarted:false,retirementAllowed:false};
 await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({databaseBytes,capacityFits:capacity.capacityFits,requiredBytes:capacity.requiredBytes,freeBytes:capacity.freeBytes,minimumFreeBytes:capacity.minimumFreeBytes,restoreStarted:false}));
}catch(e){console.error(JSON.stringify({error:/^[A-Z][A-Z0-9_]+$/u.test(e?.message??'')?e.message:'ISOLATION_PREFLIGHT_FAILED'}));process.exitCode=1;}
