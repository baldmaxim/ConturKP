import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BlobStore } from '../packages/storage/src/index.ts';
import { PacketInput, compilePacket, packetChanges, type IPacketInput } from '../apps/server/src/formPackets.ts';
import { checkCalculationTotals, packetMoney } from '../apps/server/src/formPacketMoney.ts';
import { n, startFakeTenderHub, type IFakeTenderHub } from '../scripts/tenderhub-fake.ts';
import { adminMember, captureNow, linkSource, standardTender, TH, TH_KEY, tenderHubConfig } from './calculationFixtures.ts';
import { buildScenario, createTestDb, idem, makeApp, makeWorker, testConfig, type IScenario, type ITestDb } from './helpers.ts';

const input = (revisionId: string): IPacketInput => PacketInput.parse({
 definition: {schema: {schemaVersion:'forms/1',title:'Проверка страхования',sections:[{key:'main',title:'Цена',fields:[{key:'th_total',label:'TenderHub',type:'number'},{key:'vat_rate',label:'НДС',type:'number'}]}]},recipes:{},outputs:[]},
 values:{th_total:'1870.90',vat_rate:'22'},calculationRevisionId:revisionId,
});
it('страхование объясняет остаток только при явном вводе; цена не увеличивается повторно',()=>{
 expect(checkCalculationTotals('1870.90','1860.90').reconciled).toBe(false);
 expect(checkCalculationTotals('1870.90','1860.90','10')).toMatchObject({reconciled:true,difference:'10.00',insuranceAmount:'10.00',unexplainedDifference:'0.00'});
 expect(checkCalculationTotals('1870.90','1860.90','9').reconciled).toBe(false);
 expect(checkCalculationTotals('1870.90','1860.90','11').reconciled).toBe(false);
 expect(checkCalculationTotals('100','90','9.99').reconciled).toBe(true);
 expect(()=>checkCalculationTotals('100','90','-10')).toThrow('неотрицательное');
 const before=input(randomUUID()),after=structuredClone(before);
 after.calculationInsurance={calculationRevisionId:before.calculationRevisionId!,amount:'10',basis:'Подтверждено владельцем для этой ревизии'};
 expect(compilePacket(after).data).toEqual(compilePacket(before).data);
 expect(packetMoney(after.values.th_total!,after.values.vat_rate!,[]).total).toBe('1870.90');
 expect(packetChanges(before,after)).toEqual(['calculationInsurance']);
});
it('расшифровка требует основание и привязку к той же ревизии',()=>{
 const x=input(randomUUID());x.calculationInsurance={calculationRevisionId:randomUUID(),amount:'10',basis:'Подтверждено владельцем'};
 expect(()=>compilePacket(x)).toThrow('закреплённой ревизии');
 expect(PacketInput.safeParse({...x,calculationInsurance:{...x.calculationInsurance,basis:''}}).success).toBe(false);
 expect(PacketInput.safeParse({...x,calculationInsurance:{...x.calculationInsurance,amount:'10.001'}}).success).toBe(false);
});

let db:ITestDb,s:IScenario,hub:IFakeTenderHub,revisionId:string;
beforeAll(async()=>{
 db=await createTestDb();hub=await startFakeTenderHub({apiKey:TH_KEY});
 const tender=standardTender();tender.cached_grand_total=n('1870.90');hub.tenders.set(TH.tender,tender);
 const config=tenderHubConfig(testConfig(),hub);await new BlobStore(config.storageRoot).ensureDirs();const app=makeApp(db,undefined,config);
 s=await buildScenario(db,app);const boss=await adminMember(db,s,app,s.tenderA);
 await linkSource(boss,s.stageA,TH.tender,3);
 const cap=await captureNow(db,makeWorker(db,config),s.eng1,s.stageA);expect(cap.status,JSON.stringify(cap)).toBe('complete');revisionId=cap.revisionId;
});
afterAll(async()=>{await hub?.close();await db?.drop();});
it('API сохраняет основание и снимок, убирает только объяснённый остаток и сохраняет прежний итог',async()=>{
 const created=await s.eng1.post(`/stages/${s.stageA}/form-packets`,{title:'Расшифровка страхования'},{headers:idem()});expect(created.status,created.text).toBe(201);
 const id=created.body.id,before=input(revisionId);
 const initial=await s.eng1.put(`/form-packets/${id}`,before,{headers:{'If-Match':created.body.etag}});expect(initial.status,initial.text).toBe(200);
 expect(initial.body.calculationCheck).toMatchObject({reconciled:false,insuranceAmount:null,difference:'10.00'});
 const oldVersion=initial.body.current_version_id,oldSummary=initial.body.summary;
 const after=structuredClone(initial.body.input) as IPacketInput;
 after.calculationInsurance={calculationRevisionId:revisionId,amount:'9',basis:'Подтверждение владельца текущей подачи'};
 const partial=await s.eng1.put(`/form-packets/${id}`,after,{headers:{'If-Match':initial.body.etag}});expect(partial.status,partial.text).toBe(200);
 expect(partial.body.calculationCheck).toMatchObject({reconciled:false,unexplainedDifference:'1.00'});
 const wrong={...after,calculationInsurance:{...after.calculationInsurance,calculationRevisionId:randomUUID()}};
 expect((await s.eng1.put(`/form-packets/${id}`,wrong,{headers:{'If-Match':partial.body.etag}})).status).toBe(400);
 after.calculationInsurance.amount='10';
 const saved=await s.eng1.put(`/form-packets/${id}`,after,{headers:{'If-Match':partial.body.etag}});expect(saved.status,saved.text).toBe(200);
 expect(saved.body.summary).toEqual(oldSummary);expect(saved.body.calculationCheck).toMatchObject({reconciled:true,insuranceAmount:'10.00',insuranceBasis:after.calculationInsurance.basis});
 expect(saved.body.history[0].changes).toContain('calculationInsurance');
 const built=await s.eng1.post(`/form-packets/${id}/build`,{previewPdf:false},{headers:{...idem(),'If-Match':saved.body.etag}});expect(built.status,built.text).toBe(201);
 expect(built.body.issues.join(' ')).not.toContain('Не сверена шапка');expect(built.body.issues.join(' ')).toContain('не выпуск КП');
 const manifest=await s.eng1.getBuffer(`/form-packet-files/${built.body.files.find((f:{name:string})=>f.name==='manifest.json').id}`);expect(manifest.status).toBe(200);
 expect(JSON.parse((manifest.body as Buffer).toString()).calculationCheck).toMatchObject({reconciled:true,insuranceAmount:'10.00',insuranceBasis:after.calculationInsurance.basis});
 const previous=(await db.pool.query<{input:IPacketInput}>('SELECT input FROM form_packet_version WHERE id=$1',[oldVersion])).rows[0]!.input;expect(previous.calculationInsurance).toBeUndefined();
 expect((await s.eng3.get(`/stages/${s.stageA}/form-packets`)).status).toBe(404);
});
