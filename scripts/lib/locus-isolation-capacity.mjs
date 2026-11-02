import { physicalPath } from '../../packages/storage/src/index.ts';
import { withinRoot } from './locus-registry-export.mjs';
export const MIN_ISOLATION_FREE_BYTES = 20_000_000_000;
export function isolationCapacity({ freeBytes, backupFilesBytes, databaseBytes, plannedImportBytes, ocrReserveBytes, minimumFreeBytes = MIN_ISOLATION_FREE_BYTES }) {
 const values=[freeBytes,backupFilesBytes,databaseBytes,plannedImportBytes,ocrReserveBytes,minimumFreeBytes];
 if(!values.every(n=>Number.isSafeInteger(n)&&n>=0)||minimumFreeBytes<MIN_ISOLATION_FREE_BYTES)throw Error('INVALID_ISOLATION_CAPACITY');
 const plannedBytes=backupFilesBytes+databaseBytes+plannedImportBytes+ocrReserveBytes;
 if(!Number.isSafeInteger(plannedBytes+minimumFreeBytes))throw Error('UNSAFE_CAPACITY_TOTAL');
 return {freeBytes,backupFilesBytes,databaseBytes,plannedImportBytes,ocrReserveBytes,minimumFreeBytes,plannedBytes,requiredBytes:plannedBytes+minimumFreeBytes,
   capacityFits:freeBytes>=plannedBytes+minimumFreeBytes,clusterMustBeInsideTarget:true,copyStarted:false};
}
export async function checkIsolationReserve(readFreeBytes, minimumFreeBytes = MIN_ISOLATION_FREE_BYTES) {
 if(!Number.isSafeInteger(minimumFreeBytes)||minimumFreeBytes<MIN_ISOLATION_FREE_BYTES)throw Error('INVALID_ISOLATION_RESERVE');
 const available=await readFreeBytes();
 if(!Number.isSafeInteger(available)||available<minimumFreeBytes)throw Error('ISOLATION_DISK_BELOW_20_GB');
 return available;
}
// A restore executor must pass its AbortSignal through all child operations and stop its private cluster in finally.
export async function withIsolationDiskGuard({readFreeBytes,operation,intervalMs=1000,minimumFreeBytes=MIN_ISOLATION_FREE_BYTES}) {
 await checkIsolationReserve(readFreeBytes,minimumFreeBytes);
 const controller=new AbortController();let failure=null,busy=false;
 const timer=setInterval(async()=>{if(busy)return;busy=true;try{await checkIsolationReserve(readFreeBytes,minimumFreeBytes);}catch(e){failure=e;controller.abort(e);}finally{busy=false;}},intervalMs);
 try{
  const result=await operation(controller.signal);
  if(failure)throw failure;
  await checkIsolationReserve(readFreeBytes,minimumFreeBytes);
  return result;
 }finally{clearInterval(timer);}
}

export async function assertIsolationLayout({targetRoot,clusterDataDir,storageRoot}) {
 const [root,cluster,storage]=await Promise.all([targetRoot,clusterDataDir,storageRoot].map(physicalPath));
 if(root===cluster||root===storage||!withinRoot(root,cluster)||!withinRoot(root,storage)||withinRoot(cluster,storage)||withinRoot(storage,cluster))throw Error('ISOLATION_CLUSTER_AND_STORAGE_MUST_BE_SEPARATE_CHILDREN_OF_TARGET');
 return {targetRoot:root,clusterDataDir:cluster,storageRoot:storage};
}
