import {HISTORY_CONTENT_MAX_BYTES,historyContentExtension} from '@kontur/core';
import {parseDocx} from './docx.ts';
import {recognizeLocal} from './pipeline.ts';
import {mainPart,openOoxmlPackage,readRelationships,resolvePartPath} from './ooxmlPackage.ts';
import {elements,ownText,scanXml,decodeXmlBytes,type IXmlNode} from './xml.ts';
import {DEFAULT_LOCAL_LIMITS} from './types.ts';

export interface IHistoryChange {kind:'added'|'removed'|'changed';location:string;before:string|null;after:string|null}
export interface IHistoryComparison {status:'ready'|'partial'|'unsupported'|'unreadable';format:'text'|'cells'|'image'|'pdf'|'unsupported';changes:IHistoryChange[];warnings:string[];truncated:boolean;stats:{added:number;removed:number;changed:number}}
const limits={...DEFAULT_LOCAL_LIMITS,maxInputBytes:HISTORY_CONTENT_MAX_BYTES,maxUnzippedBytes:96*1024*1024,maxPartBytes:48*1024*1024,maxCells:150_000,maxPages:1000,maxTotalTextChars:2_000_000,maxFragmentChars:10_000};
const MAX_CHANGES=600,MAX_TEXT=2_000_000;
interface IText {lines:string[];warnings:string[];complete:boolean}
const empty=():IText=>({lines:[],warnings:[],complete:true});
const textOf=(n:IXmlNode):string=>n.children.map(c=>typeof c==='string'?c:textOf(c)).join('');

const xlsx=async(bytes:Buffer):Promise<Map<string,string>>=>{
 const pkg=await openOoxmlPackage(bytes,limits),result=new Map<string,string>();let chars=0;
 try{
  const main=await mainPart(pkg,'xl/workbook.xml'),workbook=await pkg.readXml(main),rels=await readRelationships(pkg,main);
  const stringsRel=rels.find(r=>!r.external&&r.type.endsWith('/sharedStrings'));
  const strings=stringsRel?elements(await pkg.readXml(resolvePartPath(main,stringsRel.target)),'x:si').map(si=>elements(si,'x:t').map(ownText).join('')+elements(si,'x:r').map(r=>elements(r,'x:t').map(ownText).join('')).join('')):[];
  const sheets=elements(elements(workbook,'x:sheets')[0]??workbook,'x:sheet');
  for(const sheet of sheets){
   const name=sheet.attrs.name??'Лист',rel=rels.find(r=>r.id===sheet.attrs['r:id']&&!r.external);if(!rel)throw Error('Не удалось прочитать лист '+name);
   result.set(name+' · [лист]','Лист присутствует');
   let cell:{ref:string;type:string;value:string;formula:string;inline:string;formulaAttrs:Record<string,string>}|null=null,capture='',inRph=false;
   scanXml(decodeXmlBytes(await pkg.read(resolvePartPath(main,rel.target))),{
    open:(tag,attrs)=>{
     if(tag==='x:c')cell={ref:attrs.r??'',type:attrs.t??'',value:'',formula:'',inline:'',formulaAttrs:{}};
     else if(cell&&tag==='x:f'){capture='formula';cell.formulaAttrs={...attrs};}
     else if(cell&&tag==='x:v')capture='value';else if(tag==='x:rPh')inRph=true;else if(cell&&tag==='x:t'&&!inRph)capture='inline';
    },
    text:value=>{if(cell&&capture)cell[capture as 'value'|'formula'|'inline']+=value;},
    close:tag=>{
     if(['x:f','x:v','x:t'].includes(tag))capture='';if(tag==='x:rPh')inRph=false;
     if(tag!=='x:c'||!cell)return;
     const c=cell;cell=null;if(!/^[A-Z]{1,3}[1-9][0-9]*$/.test(c.ref))throw Error('Ячейка без адреса');
     if(c.type==='s'&&(!/^\d+$/.test(c.value)||strings[Number(c.value)]===undefined))throw Error('Не удалось прочитать строковое значение ячейки '+c.ref);
     const value=c.type==='s'?strings[Number(c.value)]!:c.type==='inlineStr'?c.inline:c.value;
     const formula=c.formula||Object.keys(c.formulaAttrs).length?'Формула: '+c.formula+(c.formulaAttrs.t==='shared'?' [общая, si='+c.formulaAttrs.si+']':'')+'\n':'';
     if(!value&&!formula)return;const text=formula+(formula?'Сохранённое значение: ':'')+value;
     chars+=text.length;if(chars>MAX_TEXT||result.size>=limits.maxCells)throw Error('Таблица превышает предел сравнения');result.set(name+' · '+c.ref,text);
    },
   });
  }
  return result;
 }finally{pkg.close();}
};

const extract=async(bytes:Buffer,ext:string):Promise<IText>=>{
 if(bytes.length>HISTORY_CONTENT_MAX_BYTES)throw Error('Версия превышает 64 МиБ');
 if(ext==='docx'){
  const r=await parseDocx(bytes,limits),lines=r.fragments.map(f=>f.text),warnings=['Сравнивается текст и таблицы. Оформление и изображения не сравниваются.'];
  const pkg=await openOoxmlPackage(bytes,limits);
  try{const main=await mainPart(pkg,'word/document.xml');for(const rel of await readRelationships(pkg,main)){
   const kind=rel.type.split('/').at(-1);if(rel.external||!['header','footer','comments'].includes(kind??''))continue;
   const root=await pkg.readXml(resolvePartPath(main,rel.target)),blocks:string[]=[];
   const visit=(node:IXmlNode)=>{if(node.name==='w:p'){const texts:string[]=[];const walk=(n:IXmlNode)=>{if(n.name==='w:t')texts.push(textOf(n));else for(const child of n.children)if(typeof child!=='string')walk(child);};walk(node);if(texts.length)blocks.push(texts.join(''));}else for(const child of node.children)if(typeof child!=='string')visit(child);};
   visit(root);if(blocks.length)lines.push('['+(kind==='header'?'Верхний колонтитул':kind==='footer'?'Нижний колонтитул':'Комментарии')+']',...blocks);
  }}finally{pkg.close();}
  if(lines.join('\n').length>MAX_TEXT)throw Error('Текст превышает предел сравнения');return {lines,warnings,complete:true};
 }
 if(ext==='pdf'){
  const r=await recognizeLocal({format:'pdf',bytes,limits,ocr:null,ocrDpi:144,ocrPageTimeoutMs:10_000,throwIfStopped:()=>{}});
  const missing=r.units.filter(u=>u.status==='missing'||u.status==='failed').length;
  return {lines:r.fragments.flatMap(f=>f.text.split(/\r?\n/)),complete:missing===0,warnings:['Сравнивается текстовый слой PDF. Чертежи, изображения и оформление доступны в сохранённых оригиналах.',...(missing?['Страниц без доступного текста: '+missing+'. Для них используйте просмотр оригиналов.']:[])]};
 }
 let text:string;
 if(bytes[0]===255&&bytes[1]===254)text=new TextDecoder('utf-16le',{fatal:true}).decode(bytes.subarray(2));
 else if(bytes[0]===254&&bytes[1]===255)text=new TextDecoder('utf-16be',{fatal:true}).decode(bytes.subarray(2));
 else{try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text=new TextDecoder('windows-1251').decode(bytes);}}
 if(text.includes('\0')||text.length>MAX_TEXT)throw Error('Текст недоступен или превышает предел сравнения');
 return {lines:text.replace(/^\uFEFF/,'').replace(/\r\n|\r/g,'\n').split('\n'),warnings:[],complete:true};
};

// Unique common lines anchor the comparison. Small gaps use LCS; a large unmatched gap is shown as one explicit block.
const lineChanges=(a:string[],b:string[]):IHistoryChange[]=>{
 const out:IHistoryChange[]=[];
 const addGap=(from:number,to:number,start:number,end:number)=>{
  if(from===to&&start===end)return;
  const n=to-from,m=end-start;
  if(n*m>250_000){out.push({kind:n&&m?'changed':n?'removed':'added',location:'Строки '+(from+1)+'–'+to+' / '+(start+1)+'–'+end,before:n?a.slice(from,to).join('\n'):null,after:m?b.slice(start,end).join('\n'):null});return;}
  const dp=Array.from({length:n+1},()=>new Uint32Array(m+1));
  for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i]![j]=a[from+i]===b[start+j]?1+dp[i+1]![j+1]!:Math.max(dp[i+1]![j]!,dp[i]![j+1]!);
  let i=0,j=0,old:string[]=[],next:string[]=[],oi=from,ni=start;
  const flush=()=>{if(old.length||next.length)out.push({kind:old.length&&next.length?'changed':old.length?'removed':'added',location:'Строка '+(oi+1)+' → '+(ni+1),before:old.length?old.join('\n'):null,after:next.length?next.join('\n'):null});old=[];next=[];};
  while(i<n||j<m){if(i<n&&j<m&&a[from+i]===b[start+j]){flush();i++;j++;oi=from+i;ni=start+j;}else if(i<n&&(j===m||dp[i+1]![j]!>=dp[i]![j+1]!)){if(!old.length&&!next.length){oi=from+i;ni=start+j;}old.push(a[from+i++]!);}else{if(!old.length&&!next.length){oi=from+i;ni=start+j;}next.push(b[start+j++]!);}}flush();
 };
 if(a.length>30_000||b.length>30_000)throw Error('Больше 30 000 строк: используйте сохранённые оригиналы');
 const ai=new Map<string,{count:number;index:number}>(),bi=new Map<string,{count:number;index:number}>();
 const add=(map:typeof ai,s:string,index:number)=>{const old=map.get(s);if(old)old.count++;else map.set(s,{count:1,index});};a.forEach((s,i)=>add(ai,s,i));b.forEach((s,i)=>add(bi,s,i));
 const pairs=[...ai].filter(([s,v])=>v.count===1&&bi.get(s)?.count===1).map(([s,v])=>[v.index,bi.get(s)!.index] as [number,number]).sort((x,y)=>x[0]-y[0]);
 const tails:number[]=[],previous=new Int32Array(pairs.length).fill(-1),indices:number[]=[];
 pairs.forEach((p,i)=>{let lo=0,hi=tails.length;while(lo<hi){const mid=(lo+hi)>>1;if(tails[mid]!<p[1])lo=mid+1;else hi=mid;}if(lo)previous[i]=indices[lo-1]!;tails[lo]=p[1];indices[lo]=i;});
 const anchors:[number,number][]=[];for(let i=indices.at(-1)??-1;i>=0;i=previous[i]!)anchors.push(pairs[i]!);anchors.reverse();
 let x=0,y=0;for(const [i,j] of [...anchors,[a.length,b.length] as [number,number]]){addGap(x,i,y,j);x=i+1;y=j+1;}return out;
};

export const compareHistoryBuffers=async(path:string,before:Buffer|null,after:Buffer|null):Promise<IHistoryComparison>=>{
 const ext=historyContentExtension(path),result:IHistoryComparison={status:'ready',format:'text',changes:[],warnings:[],truncated:false,stats:{added:0,removed:0,changed:0}};
 if(['png','jpg','jpeg','gif','webp','bmp'].includes(ext))return {...result,format:'image'};
 if(!['docx','xlsx','pdf','txt','csv','md','json','xml','yaml','yml','svg'].includes(ext))return {...result,status:'unsupported',format:'unsupported',warnings:['Текстовое сравнение этого формата пока недоступно. Используйте сохранённые оригиналы.']};
 try{
  if(ext==='xlsx'){
   const a=before?await xlsx(before):new Map<string,string>(),b=after?await xlsx(after):new Map<string,string>();result.format='cells';
   for(const key of [...new Set([...a.keys(),...b.keys()])].sort((x,y)=>x.localeCompare(y,'ru',{numeric:true}))){const old=a.get(key)??null,next=b.get(key)??null;if(old!==next)result.changes.push({kind:old===null?'added':next===null?'removed':'changed',location:key,before:old,after:next});}
   result.warnings=['Сравниваются ячейки, формулы и сохранённые значения. Формулы не пересчитываются; оформление, изображения и диаграммы не сравниваются.'];
  }else{
   const a=before?await extract(before,ext):empty(),b=after?await extract(after,ext):empty();result.format=ext==='pdf'?'pdf':'text';result.changes=lineChanges(a.lines,b.lines);result.warnings=[...new Set([...a.warnings,...b.warnings])];if(!a.complete||!b.complete)result.status='partial';
  }
  for(const c of result.changes)result.stats[c.kind]++;
  if(result.changes.length>MAX_CHANGES){result.truncated=true;result.changes=result.changes.slice(0,MAX_CHANGES);}
  for(const c of result.changes)for(const side of ['before','after'] as const)if(c[side]&&c[side]!.length>20_000){c[side]=c[side]!.slice(0,20_000);result.truncated=true;}
  return result;
 }catch(error){return {...result,status:'unreadable',changes:[],warnings:[error instanceof Error?error.message:'Не удалось прочитать сохранённую версию']};}
};
