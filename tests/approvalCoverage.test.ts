// Этап 13 — актуальность кандидата по правилам покрытия state-machines §1.1 (D-033 В-13-5; S13-01, RT-03, RT-08):
// документ, поступивший до сборки, но не вошедший в закреплённый снимок, ставит удержание при создании кандидата и
// запрещает согласование до решения; партия без зарегистрированных элементов не покрыта, пока у каждого элемента нет
// исхода; незавершённая партия (остановленный worker) не покрыта; несвежий канал поступления — INTAKE_NOT_CURRENT.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drain, idem, type TestClient } from './helpers.ts';
import { acceptAll, approve, assembled, buildStage13, closeStage13, codes, notApplicable, openHolds, view, type IStage13 } from './approvalFixtures.ts';
import { uploadDocument } from './searchFixtures.ts';
import { buildZip } from './zip.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ROOT = mkdtempSync(join(tmpdir(), 'kontur-intake-13-'));
let st: IStage13;

const upload = (c: TestClient, name: string, data: Buffer) =>
  c.post(`/stages/${st.e.s.stageA}/imports?name=${encodeURIComponent(name)}`, data, {
    headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': idem()['Idempotency-Key'] },
  });

beforeAll(async () => {
  st = await buildStage13({ config: { intakeRoots: [ROOT], intakeStabilitySeconds: 1 } });
});
afterAll(async () => {
  await closeStage13(st);
});

describe('S13-01 — документ до сборки вне закреплённого снимка (D-033)', () => {
  it('кандидат на старом снимке получает удержание при создании; согласование — INPUTS_CHANGED; «не влияет» — согласуется', async () => {
    const fresh = await assembled(st);
    expect(fresh.current).toBe(true);
    expect(fresh.holds.total).toBe(0);
    // Новый документ зарегистрирован до сборки, но снимок области (и реестр) прежние.
    await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'Дополнение к ТЗ до сборки.pdf');
    let c = await assembled(st);
    expect(c.current).toBe(false);
    expect(c.holds.open).toBeGreaterThan(0);
    const types = (await openHolds(st, c.id)).map((h) => h.event.type);
    expect(types).toEqual(expect.arrayContaining(['import_accepted', 'document_revision_registered']));
    await acceptAll(st, c);
    const refused = await approve(st, c);
    expect(refused.status, refused.text).toBe(409);
    expect(codes(refused.body as never)).toEqual(['INPUTS_CHANGED']);
    expect(await notApplicable(st, c.id, 'Дополнение не меняет условий КП')).toBe(types.length);
    c = await view(st, c.id);
    expect(c.current).toBe(true);
    const ok = await approve(st, c);
    expect(ok.status, ok.text).toBe(200);
  });
});

describe('исходы партии импорта (RT-08) и остановленный worker (RT-03)', () => {
  it('партия, где ни один элемент не зарегистрирован, не покрыта; исход руководителя «неприменимо» по каждому элементу её покрывает, пробел в истории', async () => {
    const r = await upload(st.e.s.eng1, 'повреждённые.zip', buildZip([{ name: 'P1.pdf', data: Buffer.from('повреждён 1') }, { name: 'P2.pdf', data: Buffer.from('повреждён 2') }]));
    expect(r.status, r.text).toBe(202);
    await drain(st.e.worker);
    const batch = (await st.e.s.eng1.get(`/imports/${r.body.id}`)).body;
    expect(batch.status).toBe('completed_with_errors');
    // Кандидат после партии: её событие не покрыто, пока у элементов нет исхода.
    let c2 = await assembled(st);
    const holds = await openHolds(st, c2.id);
    const forBatch = (await st.db.pool.query("SELECT h.id FROM readiness_hold h JOIN stage_input_event e ON e.id = h.input_event_id WHERE h.candidate_id = $1 AND e.ref_id = $2 AND h.status = 'open'", [c2.id, r.body.id])).rows;
    expect(forBatch).toHaveLength(1);
    // Остальные (документы прошлых сценариев) — «не влияет», партию оставляем.
    const others = holds.filter((h) => h.id !== forBatch[0].id);
    const res = await st.e.s.manager.post(`/release-candidates/${c2.id}/holds/resolve`, { holdIds: others.map((h) => h.id), resolution: 'not_applicable', reason: 'Прошлые документы не влияют' }, { headers: idem() });
    expect(res.status, res.text).toBe(200);
    c2 = await view(st, c2.id);
    expect(c2.current).toBe(false);
    for (const item of batch.items as { id: string; rowVersion: number }[]) {
      const ok = await st.e.s.manager.post(`/import-items/${item.id}/resolve`, { resolution: 'not_applicable', reason: 'Повреждённые черновики, не документы заказчика' }, {
        headers: { 'If-Match': `"${item.id}:${item.rowVersion}"`, ...idem() },
      });
      expect(ok.status, ok.text).toBe(200);
    }
    c2 = await view(st, c2.id);
    expect(c2.current).toBe(true);
    // Отказ элементов остаётся в истории партии.
    const after = (await st.e.s.eng1.get(`/imports/${r.body.id}`)).body;
    expect(after.items.every((i: { status: string }) => i.status === 'rejected')).toBe(true);
  });

  it('незавершённая партия при остановленном worker не покрыта: удержание у действующего кандидата сразу, без фоновой обработки', async () => {
    let c = await assembled(st);
    await notApplicable(st, c.id, 'Прошлые события не влияют');
    c = await view(st, c.id);
    expect(c.current).toBe(true);
    const r = await upload(st.e.s.eng1, 'ещё не разобрано.zip', buildZip([{ name: 'X.pdf', data: Buffer.from('%PDF-1.4 не разобран') }]));
    expect(r.status).toBe(202);
    // Worker не запускался: партия «выполняется», событие принятия уже действует (state-machines §1.1).
    expect((await st.db.pool.query('SELECT status FROM import_batch WHERE id = $1', [r.body.id])).rows[0].status).toBe('running');
    c = await view(st, c.id);
    expect(c.current).toBe(false);
    expect((await openHolds(st, c.id)).map((h) => h.event.type)).toContain('import_accepted');
    await acceptAll(st, c);
    expect(codes((await approve(st, c)).body as never)).toEqual(['INPUTS_CHANGED']);
    await drain(st.e.worker);
  });
});

describe('свежесть каналов поступления (INTAKE_NOT_CURRENT)', () => {
  it('наблюдаемая папка без успешного скана блокирует согласование; риском не снимается; отключение руководителем с причиной снимает блокер', async () => {
    let c = await assembled(st);
    await notApplicable(st, c.id, 'Прошлые события не влияют');
    c = await view(st, c.id);
    await acceptAll(st, c);
    const dir = join(ROOT, 'tender-a');
    mkdirSync(dir, { recursive: true });
    const ch = await st.e.s.admin.post(`/tenders/${st.e.s.tenderA}/intake-channels`, { origin: 'local', locator: dir, scanIntervalSeconds: 3600 }, { headers: idem() });
    expect(ch.status, ch.text).toBe(201);
    c = await view(st, c.id);
    expect(codes(c.gate.approve)).toEqual(['INTAKE_NOT_CURRENT']);
    const refused = await approve(st, c);
    expect(codes(refused.body as never)).toEqual(['INTAKE_NOT_CURRENT']);
    const risk = await st.e.s.manager.post(`/release-candidates/${c.id}/risk-acceptances`, { blockerCode: 'INTAKE_NOT_CURRENT', subjectType: 'intake_channel', subjectId: ch.body.id, reason: 'Папка временно не нужна' }, { headers: idem() });
    expect(risk.body.current.reason).toBe('risk_not_acceptable');
    const list = (await st.e.s.manager.get(`/tenders/${st.e.s.tenderA}/intake-channels`)).body.items as { id: string; etag?: string; rowVersion?: number }[];
    const cur = list.find((x) => x.id === ch.body.id)!;
    const etag = cur.etag ?? `"${cur.id}:${cur.rowVersion ?? 1}"`;
    const off = await st.e.s.manager.patch(`/intake-channels/${ch.body.id}`, { active: false, disabledReason: 'Папка не используется в этом тендере' }, { headers: { 'If-Match': etag } });
    expect(off.status, off.text).toBe(200);
    c = await view(st, c.id);
    expect(c.gate.approve!.ok).toBe(true);
    expect((await approve(st, c)).status).toBe(200);
  });
});
