import {open,type ZipFile} from 'yauzl';
import type {Readable} from 'node:stream';
import {historyContentExtension} from '@kontur/core';
import {decodeXmlBytes,parseXmlTree,elements,ownText} from './xml.ts';

const MAX_PROPERTY_BYTES=64*1024;
// This is document-supplied metadata, not a Windows audit identity or the file owner.
export const historyDocumentEditor=(bytes:Buffer):string|null=>{
 if(bytes.length>MAX_PROPERTY_BYTES)return null;
 try{const root=parseXmlTree(decodeXmlBytes(bytes));if(root.name!=='cp:coreProperties')return null;
  const editors=elements(root,'cp:lastModifiedBy');if(editors.length!==1||elements(editors[0]!).length)return null;
  return ownText(editors[0]!).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,200)||null;
 }catch{return null;}
};
export const readHistoryDocumentEditor=async(name:string,path:string):Promise<string|null>=>{
 if(!['docx','xlsx'].includes(historyContentExtension(name)))return null;
 const bytes=await new Promise<Buffer|null>(resolve=>{
  let zip:ZipFile|undefined,stream:Readable|undefined,done=false,entries=0;
  const finish=(value:Buffer|null)=>{if(done)return;done=true;clearTimeout(timer);stream?.destroy();zip?.close();resolve(value);};
  const timer=setTimeout(()=>finish(null),1500);
  open(path,{lazyEntries:true,autoClose:false,validateEntrySizes:true},(error,file)=>{
   if(error||!file){finish(null);return;}zip=file;if(done){file.close();return;}
   file.on('error',()=>finish(null));file.on('end',()=>finish(null));
   file.on('entry',entry=>{
    if(done)return;
    if(++entries>5000){finish(null);return;}
    if(entry.fileName!=='docProps/core.xml'){file.readEntry();return;}
    if(entry.uncompressedSize>MAX_PROPERTY_BYTES||entry.compressedSize>MAX_PROPERTY_BYTES||(entry.generalPurposeBitFlag&1)){finish(null);return;}
    file.openReadStream(entry,(error,input)=>{
     if(error||!input){finish(null);return;}stream=input;if(done){input.destroy();return;}
     const parts:Buffer[]=[];let size=0;
     input.on('error',()=>finish(null));input.on('data',(part:Buffer)=>{size+=part.length;if(size>MAX_PROPERTY_BYTES)finish(null);else parts.push(part);});
     input.on('end',()=>finish(Buffer.concat(parts)));
    });
   });file.readEntry();
  });
 });
 return bytes?historyDocumentEditor(bytes):null;
};
