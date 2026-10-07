// Этап 13 — права на содержимое пунктов матрицы (урок R11-01, R08-02): критическое замечание по письму из ящика, к
// которому у инженера 2 нет доступа. Его заголовок не попадает в карточку инженера 2 (пункт без текста, «закрыт»), не
// попадает в манифест выпуска (родовой заголовок); манифест с решением по закрытому предмету инженер 2 не читает
// (409 restricted_basis, R13-02), инженер 1 с доступом — читает; руководитель без доступа к ящику не принимает риск по
// такому пункту (409 restricted_fragments); идентификатор письма не раскрывается списком удержаний.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { idem } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, setMailAccess } from './mailFixtures.ts';
import { etagOf } from './reviewFixtures.ts';
import { fixScope } from './searchFixtures.ts';
import { acceptAll, acceptRisk, approve, assembled, buildStage13, closeStage13, notApplicable, release, view, type IStage13 } from './approvalFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const SECRET = 'Секретное условие письма для замечания этапа 13';
const MAIL = ['mail.read', 'mail.import', 'mail.link'];
let st: IStage13;
let box = '';
let messageId = '';
let findingId = '';

beforeAll(async () => {
  st = await buildStage13();
  box = await createMailbox(st.e.s.admin, 'approval-13@contractor.example.test', 'Ящик этапа 13');
  for (const id of [st.e.s.ids.eng1, st.e.s.ids.manager]) await setMailAccess(st.e.s.admin, box, id, MAIL);
  const letter = await importEml(st.e.s.eng1, st.e.worker, box, eml({ messageId: 'approval-13@example.test', subject: 'Условие', text: SECRET }));
  messageId = letter.messageId!;
  await linkMail(st.e.s.eng1, messageId, st.e.s.tenderA, st.e.s.stageA);
  // Основание замечания — фрагмент снимка этапа: новый снимок с письмом (реестр и комплект остаются на прежнем снимке).
  await fixScope(st.e.s.manager, st.e.s.stageA);
  const fragment = (await st.db.pool.query("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [letter.revisionId])).rows[0].id;
  const f = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/findings`, { title: `Не учтено: ${SECRET}`, severity: 'critical', confidence: 'high', evidence: [{ side: 'left', fragmentId: fragment }] }, { headers: idem() });
  expect(f.status, f.text).toBe(201);
  findingId = f.body.id as string;
});
afterAll(async () => {
  await closeStage13(st);
});

describe('пункты матрицы по правам пользователя', () => {
  it('инженер без доступа к ящику видит пункт замечания без текста; руководитель с доступом — с текстом; список удержаний без ID письма', async () => {
    const c = await assembled(st);
    const eng2 = await st.e.s.eng2.get(`/release-candidates/${c.id}`);
    expect(eng2.status).toBe(200);
    expect(eng2.text).not.toContain(SECRET);
    const item = (eng2.body.gate.approve.blockers as { code: string; items: { subjectId: string; restricted: boolean; title: string }[] }[]).find((b) => b.code === 'CRITICAL_FINDINGS_OPEN')!.items.find((i) => i.subjectId === findingId)!;
    expect(item.restricted).toBe(true);
    expect((await view(st, c.id)).gate.approve!.blockers.find((b) => b.code === 'CRITICAL_FINDINGS_OPEN')!.items[0]!.title).toContain(SECRET);
    const holds = await st.e.s.eng2.get(`/stages/${st.e.s.stageA}/holds?candidateId=${c.id}`);
    expect(holds.status).toBe(200);
    expect(holds.text).not.toContain(messageId);
  });

  it('руководитель без доступа к ящику не принимает риск по закрытому пункту; с доступом — принимает; манифест выпуска без заголовка замечания и только при доступе', async () => {
    let c = await assembled(st);
    await notApplicable(st, c.id, 'Письмо и прежние документы не меняют комплект');
    await setMailAccess(st.e.s.admin, box, st.e.s.ids.manager, []);
    const denied = await acceptRisk(st, c, { blockerCode: 'CRITICAL_FINDINGS_OPEN', subjectType: 'finding', subjectId: findingId, reason: 'Риск без чтения оснований' });
    expect(denied.status, denied.text).toBe(409);
    expect(denied.body.current.reason).toBe('restricted_fragments');
    await setMailAccess(st.e.s.admin, box, st.e.s.ids.manager, MAIL);
    c = await view(st, c.id);
    await acceptAll(st, c);
    const a = await approve(st, (c = await view(st, c.id)));
    expect(a.status, a.text).toBe(200);
    const r = await release(st, await view(st, c.id, st.e.s.eng1), a.body.approval.id as string);
    expect(r.status, r.text).toBe(201);
    const closed = await st.e.s.eng2.getBuffer(`/releases/${r.body.release.id}/manifest`);
    expect(closed.status).toBe(409);
    expect((closed.body as Buffer).toString('utf8')).not.toContain(SECRET);
    const manifest = await st.e.s.eng1.getBuffer(`/releases/${r.body.release.id}/manifest`);
    expect(manifest.status).toBe(200);
    const text = (manifest.body as Buffer).toString('utf8');
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).acceptedRisks.find((x: { code: string }) => x.code === 'CRITICAL_FINDINGS_OPEN')).toMatchObject({ subjectId: findingId, title: `критическое замечание ${findingId}` });
  });

  it('риск этапа 09 по закрытому замечанию (R13-02): причина не видна инженеру 2; манифест выпуска с этим риском — только при доступе', async () => {
    const RISK09 = 'SECRET-09: условие письма принято на проверке';
    const tr = await st.e.s.manager.post(
      `/findings/${findingId}/transitions`,
      { to: 'accepted_risk', reason: RISK09, statement: 'Риск по условию письма принят' },
      { headers: { 'If-Match': await etagOf(st.e.s.manager, `/findings/${findingId}`), ...idem() } },
    );
    expect(tr.status, tr.text).toBe(200);
    let c = await assembled(st);
    await notApplicable(st, c.id, 'Прошлые события не влияют');
    c = await view(st, c.id);
    await acceptAll(st, c);
    c = await view(st, c.id);
    expect(c.gate.approve!.blockers.find((b) => b.code === 'CRITICAL_FINDINGS_OPEN')).toBeUndefined();
    expect(c.gate.warnings!.reviewRisks.map((r) => r.findingId)).toContain(findingId);
    const card = await st.e.s.eng2.get(`/release-candidates/${c.id}`);
    expect(card.text).not.toContain(RISK09);
    expect(card.text).not.toContain(SECRET);
    const a = await approve(st, c);
    expect(a.status, a.text).toBe(200);
    const r = await release(st, await view(st, c.id, st.e.s.eng1), a.body.approval.id as string);
    expect(r.status, r.text).toBe(201);
    const id = r.body.release.id as string;
    expect((await st.e.s.eng2.getBuffer(`/releases/${id}/manifest`)).status).toBe(409);
    const open = await st.e.s.eng1.getBuffer(`/releases/${id}/manifest`);
    expect(open.status).toBe(200);
    const m = JSON.parse((open.body as Buffer).toString('utf8'));
    expect(m.acceptedRisks.some((x: { subjectId: string }) => x.subjectId === findingId)).toBe(false);
    expect(m.reviewRisks.find((x: { findingId: string }) => x.findingId === findingId)).toMatchObject({ reason: RISK09 });
  });
});
