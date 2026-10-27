// Validate donor provenance and page identities before importing OCR. No network or writes.
export function readLocusMarkdown(text, expected) {
  const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if(!match)throw new Error('locus_frontmatter_missing');
  const fields={};for(const line of match[1].split(/\r?\n/)){const m=/^([a-z_]+):\s*(.*)$/.exec(line);if(!m)continue;try{fields[m[1]]=JSON.parse(m[2]);}catch{fields[m[1]]=m[2];}}
  const sourceTime=Date.parse(fields.source_mtime);
  if(fields.source_path!==expected.path||!Number.isSafeInteger(fields.source_size)||fields.source_size!==expected.size||!Number.isFinite(sourceTime)||!Number.isFinite(expected.mtimeMs)||Math.abs(sourceTime-expected.mtimeMs)>2)throw new Error('locus_origin_mismatch');
  const body=text.slice(match[0].length),markers=[...body.matchAll(/^## OCR page (\d+)\s*$/gm)],pages=[];
  for(let i=0;i<markers.length;i++){const n=Number(markers[i][1]);if(pages.some(p=>p.page===n)||!Number.isSafeInteger(n)||n<1)throw new Error('locus_duplicate_or_invalid_page');pages.push({page:n,text:body.slice(markers[i].index+markers[i][0].length,markers[i+1]?.index??body.length).trim()});}
  return {body,pages};
}
export function validateLocusPages(pages, pageCount) {
  if(!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>10000)throw new Error('locus_invalid_original_page_count');
  const seen=new Set();for(const p of pages){if(!Number.isSafeInteger(p.page)||p.page<1||p.page>pageCount||seen.has(p.page))throw new Error('locus_page_outside_original_or_duplicate');if(typeof p.text!=='string'||p.text.length>2_000_000)throw new Error('locus_invalid_page_text');if(p.confidence!==null&&p.confidence!==undefined&&(!Number.isFinite(p.confidence)||p.confidence<0||p.confidence>100))throw new Error('locus_invalid_confidence');seen.add(p.page);}
  return new Map(pages.map(p=>[p.page,p]));
}
export function ocrParagraphs(text) {
  return text.replace(/\r\n?/g,'\n').split(/\n\s*\n|\n(?=\s*\d+(?:\.\d+){1,5}\.?\s+)/).map(p=>p.trim()).filter(Boolean);
}
// OCR can place an explicit role label and its organization in separate paragraphs.
// Rejoin only that exact same-page pair, retaining the source text and blank line.
export function contractOcrParagraphs(text) {
  const parts=ocrParagraphs(text),out=[];
  for(let i=0;i<parts.length;i++){
    const label=parts[i],next=parts[i+1];
    if(/^(?:Заказчик|Генподрядчик|Подрядчик)\s*:$/.test(label)&&/^(?:ООО|АО|ПАО|ЗАО|ТОО|ИП)\s*«[^»]+»/.test(next??'')){
      out.push(label+'\n\n'+next);i++;
    }else out.push(label);
  }
  return out;
}
export function withholdInvalidTextUnits(result) {
  const bad=new Set(result.fragments.filter(f=>f.text.includes('\0')).map(f=>f.unitIndex));
  if(!bad.size)return result;
  return {...result,units:result.units.map(u=>bad.has(u.index)?{...u,status:'needs_review',issues:[...new Set([...u.issues,'encoding_noise'])]}:u),fragments:result.fragments.filter(f=>!bad.has(f.unitIndex)),warnings:[...result.warnings,'invalid_unicode_units_withheld']};
}
// Keep every character and exact sheet ranges. Financial headers/totals remain single-row
// fragments because the fact extractor uses their column context. Only other adjacent
// rows are grouped; this avoids tens of thousands of tiny inserts for a large estimate.
export function compactSpreadsheetFragments(result, maxChars=18000) {
  const out=[];let pending=[];let chars=0;
  const column=n=>{let s='';while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=Math.floor((n-1)/26);}return s;};
  const flush=()=>{if(!pending.length)return;if(pending.length===1)out.push(pending[0]);else{const first=pending[0],last=pending.at(-1),colFrom=Math.min(...pending.map(f=>f.locator.colFrom)),colTo=Math.max(...pending.map(f=>f.locator.colTo)),rowFrom=first.locator.rowFrom,rowTo=last.locator.rowTo;out.push({...first,key:`group:${first.unitIndex}:r${rowFrom}-${rowTo}:${out.length}`,text:pending.map(f=>f.text).join('\n'),locator:{...first.locator,rowFrom,rowTo,colFrom,colTo,range:`${column(colFrom)}${rowFrom}:${column(colTo)}${rowTo}`},partIndex:0,partTotal:1});}pending=[];chars=0;};
  for(const f of result.fragments){const l=f.locator,prev=pending.at(-1),boundary=/итого|всего|сумма|стоимост|руб|тенге|\bRUB\b|\bKZT\b|₽|₸/iu.test(f.text);if(l?.kind!=='xlsx_cells'||boundary||f.partTotal!==1){flush();out.push(f);continue;}if(prev&&(prev.unitIndex!==f.unitIndex||prev.locator.sheet!==l.sheet||prev.locator.rowTo+1!==l.rowFrom||chars+1+f.text.length>maxChars))flush();pending.push(f);chars+=f.text.length+1;}
  flush();return {...result,fragments:out.map((f,i)=>({...f,ordinal:i+1}))};
}
