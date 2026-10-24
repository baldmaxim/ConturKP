// Размеченные формы с _KonturFitRows: растёт высота строк, исходные шрифты, объединения и печать сохраняются.
import { createCanvas } from '@napi-rs/canvas';
import { cellTexts,openPackage,sheets,writePackage,decodeXml } from './ooxml.ts';
const column=(s:string):number=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
const attr=(xml:string,name:string,fallback:number):number=>Number(new RegExp(`\\b${name}="([\\d.]+)"`,'u').exec(xml)?.[1]??fallback);
export const fitWrappedRows=(bytes:Buffer):Buffer=>{
 const zip=openPackage(bytes),styles=zip.file('xl/styles.xml')?.asText()??'';
 const fonts=[...styles.matchAll(/<font>([\s\S]*?)<\/font>/gu)].map(m=>({size:attr(/<sz\b[^>]*>/u.exec(m[1]!)?.[0]??'','val',11),name:decodeXml(/<name\b[^>]*val="([^"]*)"/u.exec(m[1]!)?.[1]??'Arial')}));
 const fontIds=[...(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/u.exec(styles)?.[1]??'').matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/gu)].map(m=>attr(m[1]!,'fontId',0));
 const ctx=createCanvas(1,1).getContext('2d');
 const texts=cellTexts(zip);
 for(const sheet of sheets(zip)){
  let xml=zip.file(sheet.part)!.asText();
  const columns=[...xml.matchAll(/<col\b[^>]*\/>/gu)].map(m=>({min:attr(m[0],'min',1),max:attr(m[0],'max',1),width:attr(m[0],'width',8.43)}));
  const heights=new Map<number,number>([...xml.matchAll(/<row\b[^>]*>/gu)].map(m=>[attr(m[0],'r',1),attr(m[0],'ht',15)]));
  const merges=[...xml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/gu)].map(m=>({first:`${m[1]}${m[2]}`,left:column(m[1]!),right:column(m[3]!),top:Number(m[2]),bottom:Number(m[4])}));
  for(const cell of texts.filter(c=>c.sheet===sheet.name&&c.text.trim())){
   const tag=new RegExp(`<c\\b[^>]*\\br="${cell.ref}"[^>]*>`,'u').exec(xml)?.[0]??'';
   const font=fonts[fontIds[attr(tag,'s',0)]??0]??{size:11,name:'Arial'};
   ctx.font=`${font.size}pt "${font.name}"`;
   const row=Number(cell.ref.match(/\d+$/u)![0]),col=column(cell.ref.replace(/\d/gu,''));
   const merge=merges.find(m=>m.first===cell.ref);
   let width=0;for(let c=col;c<=(merge?.right??col);c++)width+=(columns.find(x=>x.min<=c&&x.max>=c)?.width??8.43)*7+5;
   width=Math.max(10,width-12);
   let lines=0;
   for(const paragraph of cell.text.split('\n')){
    let line='';lines++;
    for(const word of paragraph.split(/\s+/u)){
     const candidate=line?`${line} ${word}`:word;
     if(line&&ctx.measureText(candidate).width>width){lines++;line=word;}else line=candidate;
     if(ctx.measureText(line).width>width){lines+=Math.max(0,Math.ceil(ctx.measureText(line).width/width)-1);line='';}
    }
   }
   const required=Math.ceil(lines*font.size*1.4+8);
   const bottom=merge?.bottom??row;
   let current=0;for(let r=row;r<=bottom;r++)current+=heights.get(r)??15;
   if(required>current){
    let extra=required-current;
    for(let r=row;r<=bottom&&extra>0;r++){
     const height=heights.get(r)??15,delta=Math.min(extra,Math.max(0,409.5-height));
     heights.set(r,height+delta);extra-=delta;
    }
    if(extra>0)throw new Error(`Текст ${sheet.name}!${cell.ref} не помещается в допустимую высоту строк; сократите текст или измените шаблон`);
   }
  }
  xml=xml.replace(/<row\b([^>]*?)>/gu,(whole,attrs:string)=>{
   if(whole.endsWith('/>'))return whole;
   const height=heights.get(attr(attrs,'r',1));if(!height)return whole;
   return `<row${attrs.replace(/\s+(?:ht|customHeight)="[^"]*"/gu,'')} ht="${height}" customHeight="1">`;
  });
  zip.file(sheet.part,xml);
 }
 return writePackage(zip);
};
