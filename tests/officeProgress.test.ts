import { describe, expect, it } from 'vitest';
import { officeProgress } from '../apps/web/src/pages/admin/office/officeProgress.ts';
import { buildOffice, type IOfficeTask } from '../apps/web/src/pages/admin/office/officeModel.ts';
import { placeOfficeAlerts } from '../apps/web/src/pages/admin/office/officeAlerts.ts';
import { parseXlsx, DEFAULT_LOCAL_LIMITS } from '../packages/adapters/src/index.ts';
import { edgeXlsx } from './localFixtures.ts';
const task: IOfficeTask = { id: 'job-1', kind: 'history.verify', tenderId: 'tender-1', hidden: false, count: 1, progress: { phase: 'processing', completed: 7, total: 16, unit: 'files' } };
describe('реальный прогресс офиса', () => {
  it('считает проценты из выполненного объёма; неизвестный объём не получает процент', () => {
    expect(officeProgress(task)).toEqual({ percent: 43, label: '43% · 7 из 16 файлов' });
    expect(officeProgress({ ...task, progress: null }).percent).toBeNull();
    expect(officeProgress({ ...task, progress: { ...task.progress!, completed: 16, phase: 'saving' } })).toEqual({ percent: 99, label: '99% · 16 из 16 файлов · сохранение' });
  });
  it('задача называет конкретное действие и доступный тендер', () => {
    const office=buildOffice({ at:new Date().toISOString(), workersAlive:1, tenders:[{id:'tender-1',title:'Тендер №1'}], tasks:[task], items:[{kind:task.kind,status:'running',tenderId:'tender-1',hidden:false,count:1,lastErrorCode:null,lastFailedAt:null}] });
    expect(office.desks[0]!.tasks?.[0]).toMatchObject({title:'Проверяет содержимое файлов',target:'Тендер №1',progress:task.progress});
  });
  it('все увеличенные уведомления помещаются на узкой сцене', () => {
    const roles=['intake','recognition','archive','analyst','estimator','reviewer','assembler','courier','model','other'] as const;
    const anchors=roles.map(role=>({role,x:124,y:300,width:116,height:118}));
    const placed=placeOfficeAlerts(anchors,248,650,116,118);
    for(const [i,p] of placed.entries()) {
      expect(p.x).toBeGreaterThanOrEqual(0);expect(p.y).toBeGreaterThanOrEqual(0);expect(p.x+116).toBeLessThanOrEqual(248);expect(p.y+118).toBeLessThanOrEqual(650);
      for(const q of placed.slice(i+1))expect(p.x+116<=q.x||q.x+116<=p.x||p.y+118<=q.y||q.y+118<=p.y).toBe(true);
    }
  });
  it('XLSX сообщает все листы, включая пустой; отмена останавливает дальнейший разбор', async () => {
    const steps:number[][]=[];
    await parseXlsx(edgeXlsx(),DEFAULT_LOCAL_LIMITS,{throwIfStopped:()=>undefined,onProgress:async(done,total)=>{steps.push([done,total]);}});
    expect(steps).toEqual([[0,3],[1,3],[2,3],[3,3]]);
    let stopped=false;
    await expect(parseXlsx(edgeXlsx(),DEFAULT_LOCAL_LIMITS,{throwIfStopped:()=>{if(stopped)throw new Error('stopped');},onProgress:async(done)=>{if(done===1)stopped=true;}})).rejects.toThrow('stopped');
  });
});
