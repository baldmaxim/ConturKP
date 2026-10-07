// Этап 13 — одновременные команды (задание: «два concurrent запроса не создают двойной выпуск»; A26, RT-03, I13):
// два выпуска, два согласования, два принятия риска по одному пункту — один результат; поступление источника
// одновременно с выпуском — только один из двух законных исходов (выпуск раньше — отправка удержана; импорт раньше —
// выпуск отклонён INPUTS_CHANGED). Сериализация — блокировка этапа; вторая линия — уникальность и охранники БД.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drain, idem, type TestClient } from './helpers.ts';
import { acceptAll, acceptRisk, approve, assembled, buildStage13, closeStage13, codes, notApplicable, release, view, type ICandidate13, type IStage13 } from './approvalFixtures.ts';
import { buildZip, fakePdf } from './zip.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let st: IStage13;

const upload = (c: TestClient, name: string, data: Buffer) =>
  c.post(`/stages/${st.e.s.stageA}/imports?name=${encodeURIComponent(name)}`, data, {
    headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': idem()['Idempotency-Key'] },
  });

const ready = async (): Promise<ICandidate13> => {
  let c = await assembled(st);
  await notApplicable(st, c.id, 'Прошлые события не влияют');
  c = await view(st, c.id);
  await acceptAll(st, c);
  return view(st, c.id);
};

const approved = async (): Promise<{ c: ICandidate13; approvalId: string }> => {
  const c = await ready();
  const a = await approve(st, c);
  expect(a.status, a.text).toBe(200);
  return { c: await view(st, c.id, st.e.s.eng1), approvalId: a.body.approval.id as string };
};

beforeAll(async () => {
  st = await buildStage13();
});
afterAll(async () => {
  await closeStage13(st);
});

describe('повторы и одновременность', () => {
  it('два одновременных выпуска разными ключами (и разными инженерами) — одна запись выпуска, второй — already_released (A26)', async () => {
    const { c, approvalId } = await approved();
    const [a, b] = await Promise.all([release(st, c, approvalId), release(st, c, approvalId, { client: st.e.s.eng2 })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, `${a.text}\n${b.text}`).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.current.reason).toBe('already_released');
    expect(Number((await st.db.pool.query('SELECT count(*) FROM release WHERE candidate_id = $1', [c.id])).rows[0].count)).toBe(1);
  });

  it('два одновременных согласования — одно согласование; второе — already_approved', async () => {
    const c = await ready();
    const [a, b] = await Promise.all([approve(st, c), approve(st, c)]);
    expect([a.status, b.status].sort(), `${a.text}\n${b.text}`).toEqual([200, 409]);
    expect(Number((await st.db.pool.query("SELECT count(*) FROM approval WHERE candidate_id = $1 AND status = 'active'", [c.id])).rows[0].count)).toBe(1);
  });

  it('два одновременных принятия риска по одному пункту — одна запись', async () => {
    const c = await assembled(st);
    await notApplicable(st, c.id, 'Прошлые события не влияют');
    const v = await view(st, c.id);
    const b = v.gate.approve!.blockers.find((x) => x.code === 'REVIEW_UNCERTAIN')!;
    const body = { blockerCode: b.code, subjectType: b.items[0]!.subjectType, subjectId: b.items[0]!.subjectId, reason: 'Одновременное принятие риска' };
    const [x, y] = await Promise.all([acceptRisk(st, v, body), acceptRisk(st, v, body)]);
    expect([x.status, y.status].sort(), `${x.text}\n${y.text}`).toEqual([201, 409]);
    expect(Number((await st.db.pool.query("SELECT count(*) FROM risk_acceptance WHERE candidate_id = $1 AND blocker_code = 'REVIEW_UNCERTAIN'", [c.id])).rows[0].count)).toBe(1);
  });
});

describe('поступление источника одновременно с выпуском (RT-03, оба порядка)', () => {
  it('один из двух законных исходов: выпуск раньше — событие после выпуска и отправка удержана; импорт раньше — выпуск отклонён INPUTS_CHANGED', async () => {
    const { c, approvalId } = await approved();
    const [rel, imp] = await Promise.all([release(st, c, approvalId), upload(st.e.s.eng2, 'одновременно.zip', buildZip([{ name: 'Одновременно.pdf', data: fakePdf('одновременно') }]))]);
    expect(imp.status, imp.text).toBe(202);
    const event = (await st.db.pool.query("SELECT seq FROM stage_input_event WHERE stage_id = $1 AND event_type = 'import_accepted' AND ref_id = $2", [st.e.s.stageA, imp.body.id])).rows[0];
    if (rel.status === 201) {
      const r = (await st.db.pool.query('SELECT input_version FROM release WHERE candidate_id = $1', [c.id])).rows[0];
      expect(Number(event.seq)).toBeGreaterThan(Number(r.input_version));
      const v = await view(st, c.id);
      expect(v.release!.sendReadiness.state).toBe('held');
    } else {
      expect(rel.status, rel.text).toBe(409);
      expect(codes(rel.body as never)).toEqual(['INPUTS_CHANGED']);
      expect((await view(st, c.id)).status).toBe('approved');
    }
    await drain(st.e.worker);
  });
});
