import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const contractHistorySourceKey = (root:string):string =>
  'source-'+createHash('sha256').update(resolve(root).normalize('NFC').replaceAll('/','\\').toLowerCase()).digest('hex').slice(0,24);

// Only a file ID reaches this adapter from HTTP. Root comes from server configuration.
export const openContractHistoryFile = async (root:string,path:string,expected:{size:string;mtime:string}) => {
  if (!root || !isAbsolute(root) || !path || isAbsolute(path) || /[:\u0000-\u001f]/u.test(path) ||
      path.replaceAll('\\','/').split('/').some(p=>!p||p==='.'||p==='..')) throw new Error('history_unsafe_path');
  const base=await realpath(root);
  let current=base;
  for(const part of path.replaceAll('\\','/').split('/')){
    current=join(current,part);
    if((await lstat(current)).isSymbolicLink())throw new Error('history_unsafe_path');
  }
  const physical=await realpath(current),rel=relative(base,physical);
  if(!rel||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('history_unsafe_path');
  const handle=await open(physical,'r');
  try{
    const info=await handle.stat({bigint:true});
    if(!info.isFile()||info.size>1024n*1024n*1024n)throw new Error('history_file_too_large');
    if(info.size.toString()!==expected.size||info.mtimeNs.toString()!==expected.mtime)throw new Error('history_source_changed');
    return {stream:handle.createReadStream({autoClose:true}),size:info.size.toString()};
  }catch(error){await handle.close();throw error;}
};
