import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import PizZip from 'pizzip';
import { compilePacket, packetChanges, type IPacketInput } from '../apps/server/src/formPackets.ts';
import { createTestDb, buildScenario, makeApp, idem, type ITestDb, type IScenario } from './helpers.ts';
import { templateWithMarkedSample } from './releaseFixtures.ts';
import { scanDocxTags } from '../packages/adapters/src/office/render.ts';
import { docxParagraphTexts, openPackage } from '../packages/adapters/src/office/ooxml.ts';

const input = (): IPacketInput => ({
 definition:{schema:{schemaVersion:'forms/1',title:'Общие параметры',sections:[{key:'main',title:'Параметры',fields:[
  {key:'threshold',label:'Порог',type:'number',min:'0',scale:2,required:true},
  {key:'prices_date',label:'Дата цен',type:'date'}, {key:'bsm_date',label:'Дата БСМ',type:'date'},
 ]}]},recipes:{terms:'Рост [[threshold]] %, цены [[prices_date]], БСМ [[bsm_date]].',letter:'[[threshold]] %'},recipeVariants:{},outputs:[]},
 values:{threshold:'7.25',prices_date:'2026-08-28',bsm_date:'2026-09-28'},calculationRevisionId:null,performanceBond:null,nominations:[],positions:[],notes:'Внутренняя пометка',attachments:[],
});
describe('общие данные подачи',()=>{
 it('один порог вне набора 0/5 и две независимые даты во всех документах',()=>{
  const c=compilePacket(input());expect(c.data.terms).toBe('Рост 7,25 %, цены 28.08.2026, БСМ 28.09.2026.');expect(c.data.letter).toBe('7,25 %');
 });
 it('не исполняет и не подставляет повторно содержимое значения',()=>{
  const x=input();(x.definition.schema as {sections:{fields:unknown[]}[]}).sections[0]!.fields.push({key:'text',type:'text',label:'Текст'});
  x.values.text='[[threshold]] {{threshold}}';x.definition.recipes.literal='[[text]]';
  expect(compilePacket(x).data.literal).toBe('[[threshold]] {{threshold}}');
 });
 it('отвергает неизвестный параметр и неизвестную ссылку',()=>{
  const x=input();x.definition.recipes.terms='[[absent]]';expect(()=>compilePacket(x)).toThrow('Неизвестная ссылка');
  const y=input();y.values.unknown='42';expect(()=>compilePacket(y)).toThrow('Неизвестное поле');
 });
 it('не считает внутреннюю пометку ответом; ответ без подтверждения не печатается',()=>{
  const x=input();x.definition.recipes.c01_customer='Обход подтверждения';x.positions=[{key:'c01_customer',text:'Неподтверждённый ответ',sourceId:null,confirmed:false}];
  const c=compilePacket(x);expect(c.data.c01_customer).toBe('');expect(Object.values(c.data)).not.toContain(x.notes);expect(c.issues.join('')).toContain('не подтверждена');
 });
 it('подтверждённый ответ требует источник',()=>{
  const x=input();x.positions=[{key:'c01_customer',text:'Ответ',sourceId:null,confirmed:true}];expect(()=>compilePacket(x)).toThrow('нет источника');
 });
 it('сохраняет ноль, отвергает неверную дату и отражает изменения',()=>{
  const x=input(),y=structuredClone(x);y.values.threshold='0';expect(compilePacket(y).data.letter).toBe('0 %');expect(packetChanges(x,y)).toEqual(['threshold']);
  y.values.prices_date='2026-02-30';expect(()=>compilePacket(y)).toThrow('дата');
 });
});

let db:ITestDb,s:IScenario,id:string,revisionId:string;
beforeAll(async()=>{db=await createTestDb();s=await buildScenario(db,makeApp(db));});
afterAll(async()=>{await db.drop();});
describe('комплект через штатный API',()=>{
 it('создаёт черновик и не раскрывает его постороннему тендеру',async()=>{
  const r=await s.eng1.post(`/stages/${s.stageA}/form-packets`,{title:'Проверочный комплект'},{headers:idem()});
  expect(r.status,r.text).toBe(201);id=r.body.id;
  expect((await s.eng3.get(`/stages/${s.stageA}/form-packets`)).status).toBe(404);
 });
 it('заполняет по реальной размеченной ревизии, без обхода утверждения демонстрационных форм',async()=>{
  const zip=new PizZip();
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{letter}}</w:t></w:r></w:p></w:body></w:document>');
  const schema={schemaVersion:'forms/1',title:'Письмо',sections:[{key:'main',title:'Письмо',fields:[{key:'letter',type:'text',label:'Текст'}]}]};
  const rev=await templateWithMarkedSample(s.manager,{name:'Реальная форма теста',schema,marked:zip.generate({type:'nodebuffer'}),isDemo:false});revisionId=rev.revision.id;
  const list=await s.eng1.get(`/stages/${s.stageA}/form-packets`);const p=list.body.items.find((x:{id:string})=>x.id===id);
  const x=input();x.definition.outputs=[{revisionId,name:'Письмо.docx'}];
  const r=await s.eng1.put(`/form-packets/${id}`,x,{headers:{'If-Match':p.etag}});expect(r.status,r.text).toBe(200);
  expect(r.body.seq).toBe(1);expect(r.body.history).toHaveLength(1);
  const stale=await s.eng1.put(`/form-packets/${id}`,x,{headers:{'If-Match':p.etag}});expect(stale.status).toBe(412);
 });
 it('чужой источник и неподтверждённый источник не подменяются произвольным SHA',async()=>{
  const list=await s.eng1.get(`/stages/${s.stageA}/form-packets`);const p=list.body.items.find((x:{id:string})=>x.id===id);
  const x=structuredClone(p.input) as IPacketInput;x.attachments=[{sourceId:'11111111-1111-4111-8111-111111111111'}];
  expect((await s.eng1.put(`/form-packets/${id}`,x,{headers:{'If-Match':p.etag}})).status).toBe(400);
 });
 it('новая подача переносит условия в отдельную историю',async()=>{
  const clone=await s.eng1.post(`/stages/${s.stageA}/form-packets`,{title:'Следующая подача',basedOnId:id},{headers:idem()});expect(clone.status,clone.text).toBe(201);
  const x=structuredClone(clone.body.input) as IPacketInput;x.values.threshold='12.5';
  const saved=await s.eng1.put(`/form-packets/${clone.body.id}`,x,{headers:{'If-Match':clone.body.etag}});expect(saved.status,saved.text).toBe(200);
  const list=await s.eng1.get(`/stages/${s.stageA}/form-packets`);expect(list.body.items.find((p:{id:string})=>p.id===id).input.values.threshold).toBe('7.25');
  expect(saved.body.history).toHaveLength(2);
  const modified=await db.pool.query('UPDATE form_packet_version SET input=input WHERE packet_id=$1',[id]).then(()=>false,()=>true);expect(modified).toBe(true);
 });
 it('снимок сборки хранит байты; правка не меняет прежний файл и не выдаёт право выпуска',async()=>{
  const list=await s.eng1.get(`/stages/${s.stageA}/form-packets`);const p=list.body.items.find((x:{id:string})=>x.id===id);
  const built=await s.eng1.post(`/form-packets/${id}/build`,{previewPdf:false},{headers:{...idem(),'If-Match':p.etag}});expect(built.status,built.text).toBe(201);
  const file=built.body.files.find((f:{name:string})=>f.name==='Письмо.docx');expect(file).toBeTruthy();
  const first=await s.eng1.getBuffer(`/form-packet-files/${file.id}`);expect(first.status).toBe(200);
  expect(scanDocxTags(first.body as Buffer)).toHaveLength(0);expect(docxParagraphTexts(openPackage(first.body as Buffer).file('word/document.xml')!.asText()).join(' ')).toContain('ЧЕРНОВИК');
  expect(docxParagraphTexts(openPackage(first.body as Buffer).file('word/document.xml')!.asText()).join(' ')).toContain('7,25 %');
  expect((await s.eng3.get(`/form-packet-files/${file.id}`)).status).toBe(404);
  const again=await s.eng1.getBuffer(`/form-packet-files/${file.id}`);expect(again.body).toEqual(first.body);
  expect(built.body.issues.join('')).toContain('не выпуск');
 });
});
