import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,realpathSync,mkdirSync,symlinkSync,rmSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertIsolationLayout,isolationCapacity,checkIsolationReserve,withIsolationDiskGuard,MIN_ISOLATION_FREE_BYTES} from '../scripts/lib/locus-isolation-capacity.mjs';
test('compressed dump size is not a database estimate and capacity includes DB, import, OCR and 20GB reserve',()=>{
 const args={freeBytes:108e9,backupFilesBytes:71e9,databaseBytes:12e9,plannedImportBytes:9.5e9,ocrReserveBytes:5e9};
 assert.equal(isolationCapacity(args).capacityFits,false);
 assert.throws(()=>isolationCapacity({...args,minimumFreeBytes:0}),/INVALID_ISOLATION_CAPACITY/);
 assert.equal(isolationCapacity({...args,freeBytes:140e9}).capacityFits,true);
});
test('less than 20GB prevents any operation',async()=>{
 let started=false;
 await assert.rejects(withIsolationDiskGuard({readFreeBytes:async()=>MIN_ISOLATION_FREE_BYTES-1,operation:async()=>{started=true;}}),/ISOLATION_DISK_BELOW/);
 assert.equal(started,false);
});
test('running copy is aborted when reserve falls below 20GB',async()=>{
 let calls=0,aborted=false;
 await assert.rejects(withIsolationDiskGuard({intervalMs:5,readFreeBytes:async()=>++calls<2?MIN_ISOLATION_FREE_BYTES+1:MIN_ISOLATION_FREE_BYTES-1,
 operation:signal=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}))}),/ISOLATION_DISK_BELOW/);
 assert.equal(aborted,true);
});

test('cluster and storage must be within the same isolated target, even through a junction',async t=>{
 const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'kontur-isolation-layout-'));
 t.after(()=>{assert.equal(dirname(realpathSync(dir)),parent);assert(basename(dir).startsWith('kontur-isolation-layout-'));rmSync(dir,{recursive:true,force:true});});
 const target=join(dir,'target'),outside=join(dir,'outside');mkdirSync(target);mkdirSync(outside);
 const good=await assertIsolationLayout({targetRoot:target,clusterDataDir:join(target,'postgres-data'),storageRoot:join(target,'storage')});
 assert.equal(dirname(good.clusterDataDir),good.targetRoot);
 await assert.rejects(assertIsolationLayout({targetRoot:target,clusterDataDir:outside,storageRoot:join(target,'storage')}),/ISOLATION_CLUSTER/);
 symlinkSync(outside,join(target,'alias'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(assertIsolationLayout({targetRoot:target,clusterDataDir:join(target,'alias'),storageRoot:join(target,'storage')}),/ISOLATION_CLUSTER/);
});
