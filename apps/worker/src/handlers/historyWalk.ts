import {lstat,readdir,realpath} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';

export interface IObservedMetadata {path:string;size:number;mtimeMs:number}
export const pathWithin=(child:string,parent:string):boolean=>{
 const normal=(p:string)=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
 const c=normal(child),p=normal(parent);return c===p||c.startsWith(p.endsWith(sep)?p:p+sep);
};
export const walkHistoryRoot=async(root:string,check:()=>void,limits={files:100_000,entries:150_000,depth:64})=>{
 const files:IObservedMetadata[]=[],directories:string[]=[],errors:string[]=[],keys=new Set<string>();let entries=0;
 const fail=(code:string,path:string)=>{if(errors.length<100)errors.push(code+':'+path);};
 const rootStat=await lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('history_root_unsafe');
 const canonical=await realpath(root);
 const walk=async(dir:string,rel:string,depth:number):Promise<void>=>{
  check();if(depth>limits.depth){fail('depth_limit',rel);return;}
  try{
   const ds=await lstat(dir);if(ds.isSymbolicLink()||!ds.isDirectory()||!pathWithin(await realpath(dir),canonical)){fail('unsafe_directory',rel);return;}
   const children=await readdir(dir,{withFileTypes:true});
   for(const e of children){
    check();if(++entries>limits.entries||files.length>=limits.files){fail('entry_limit',rel);return;}
    const r=rel?rel+'/'+e.name:e.name,path=join(dir,e.name);
    try{
     if(e.isSymbolicLink()){fail('reparse_point',r);continue;}
     if(e.isDirectory()){directories.push(r);await walk(path,r,depth+1);continue;}
     const st=await lstat(path);
     if(st.isSymbolicLink()||!st.isFile()){fail('special_file',r);continue;}
     const key=r.normalize('NFC').toLowerCase();if(keys.has(key)){fail('ambiguous_path',r);continue;}keys.add(key);
     files.push({path:r,size:st.size,mtimeMs:Math.trunc(st.mtimeMs)});
    }catch{fail('file_unavailable',r);}
   }
  }catch{check();fail('directory_unavailable',rel);}
 };
 await walk(root,'',0);check();
 if(await realpath(root)!==canonical)fail('root_changed','');
 return {files,directories:directories.sort(),errors,complete:errors.length===0,canonical};
};
