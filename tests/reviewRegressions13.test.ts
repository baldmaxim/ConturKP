// Регрессии Review 13-1 (docs/reviews/13-review-1.md). Написаны до исправления продукта по сценариям ревью; на коде
// 28d4cb9 сценарии R13-01…R13-04 падают, контрольные проверки проходят и до, и после.
// R13-01: прогон проверок, вход которого устарел (после прогона подтверждено требование), не допускает согласование и
//   выпуск — неснимаемый REVIEW_OUTDATED и вторая линия БД; новый прогон и новый комплект — согласуются; правка поля
//   приложения прогон не устаревает (S12-01).
// R13-02: причина принятого риска и решения по удержанию наследует закрытость предмета (письмо из закрытого ящика): нет
//   ни в карточке, ни в журнале, ни в списке удержаний; манифест выпуска (и ZIP со всеми файлами) — только тому, кто
//   видит предметы всех решений; руководитель без доступа к письму решение по его событию не принимает.
// R13-03: решение «влияет» исключает отправку выпуска навсегда — и после того, как событие стало покрытым.
// R13-04: согласование и выпуск по устаревшему показанному составу (риски, решения по удержаниям) — 409.
// Данные вымышленные.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drain, idem, type TestClient } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, setMailAccess } from './mailFixtures.ts';
import { fixScope, uploadDocument } from './searchFixtures.ts';
import { buildZip } from './zip.ts';
import {
  acceptAll,
  acceptRisk,
  approve,
  assembled,
  buildStage13,
  closeStage13,
  codes,
  filledDraft,
  notApplicable,
  openHolds,
  release,
  requirementOf,
  TZ,
  view,
  type ICandidate13,
  type IStage13,
} from './approvalFixtures.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let st: IStage13;

// Проба прямой записи в транзакции, которая всегда откатывается; отложенные проверки — немедленно.
const probe = async (fn: (q: pg.PoolClient) => Promise<unknown>): Promise<string> => {
  const client = await st.db.pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    return 'ok';
  } catch (x) {
    return (x as { code?: string }).code ?? 'error';
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
};

// Готовый к согласованию комплект: события прошлых сценариев — «не влияет», бизнес-пункты — принятый риск.
const readyToApprove = async (): Promise<ICandidate13> => {
  let c = await assembled(st);
  await notApplicable(st, c.id, 'Прошлые события не влияют на комплект');
  c = await view(st, c.id);
  await acceptAll(st, c);
  return view(st, c.id);
};

const critical = async (title: string, fragmentId: string): Promise<string> => {
  const f = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/findings`, { title, severity: 'critical', confidence: 'high', evidence: [{ side: 'left', fragmentId }] }, { headers: idem() });
  expect(f.status, f.text).toBe(201);
  return f.body.id as string;
};

const tzFragment = async (text: string): Promise<string> => (await st.db.pool.query('SELECT id FROM evidence_fragment WHERE text = $1 ORDER BY id LIMIT 1', [text])).rows[0].id as string;

const upload = (c: TestClient, name: string, data: Buffer) =>
  c.post(`/stages/${st.e.s.stageA}/imports?name=${encodeURIComponent(name)}`, data, {
    headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': idem()['Idempotency-Key'] },
  });

beforeAll(async () => {
  st = await buildStage13();
});
afterAll(async () => {
  await closeStage13(st);
});

describe('R13-04 — согласование и выпуск только показанного состава', () => {
  it('контроль: показанный состав согласуется (200) и выпускается (201); повтор выпуска — 409', async () => {
    const c = await readyToApprove();
    expect(c.gate.approve!.ok).toBe(true);
    const a = await approve(st, c);
    expect(a.status, a.text).toBe(200);
    const shown = await view(st, c.id, st.e.s.eng1);
    const r = await release(st, shown, a.body.approval.id as string);
    expect(r.status, r.text).toBe(201);
    // Повтор того же запроса с новым ключом: комплект уже выпущен.
    const again = await release(st, shown, a.body.approval.id as string);
    expect(again.status, again.text).toBe(409);
    expect(again.body.current.reason).toBe('already_released');
  });

  it('после показа принят новый риск: ETag и хэш содержимого прежние, согласование по старому составу — 409; по новому — 200 с новым риском', async () => {
    const shown = await readyToApprove();
    expect(shown.gate.approve!.ok).toBe(true);
    const risksShown = shown.gate.approve!.blockers.flatMap((b) => b.items.filter((i) => i.acceptance)).length;
    expect(risksShown).toBeGreaterThan(0);
    // В другой вкладке: инженер записывает критическое замечание, руководитель принимает по нему риск.
    const finding = await critical('Ограждение строительной площадки не учтено (R13-04)', await tzFragment(TZ.paint));
    let other = await view(st, shown.id);
    const item = other.gate.approve!.blockers.find((b) => b.code === 'CRITICAL_FINDINGS_OPEN')!.items.find((i) => i.subjectId === finding)!;
    const acc = await acceptRisk(st, other, { blockerCode: 'CRITICAL_FINDINGS_OPEN', subjectType: 'finding', subjectId: finding, subjectKey: item.subjectKey, reason: 'Ограждение предоставляет заказчик' });
    expect(acc.status, acc.text).toBe(201);
    other = await view(st, shown.id);
    expect(other.etag).toBe(shown.etag);
    expect(other.contentHash).toBe(shown.contentHash);
    expect(other.gate.approve!.ok).toBe(true);
    const stale = await approve(st, shown);
    expect(stale.status, stale.text).toBe(409);
    expect(stale.body.current.reason).toBe('composition_changed');
    expect((await view(st, shown.id)).status).toBe('ready_for_approval');
    // Без отпечатка показанного состава — не согласуется.
    const blind = await st.e.s.manager.post(`/release-candidates/${other.id}/approve`, { contentHash: other.contentHash }, { headers: { 'If-Match': other.etag, ...idem() } });
    expect(blind.status, blind.text).toBe(400);
    const ok = await approve(st, other);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.approval.acceptedRiskIds).toHaveLength(risksShown + 1);
  });

  it('после показа выпуска принято решение по новому событию: выпуск по старому составу — 409; по новому — 201', async () => {
    const c = await readyToApprove();
    const a = await approve(st, c);
    expect(a.status, a.text).toBe(200);
    const shown = await view(st, c.id, st.e.s.eng1);
    expect(shown.gate.release!.ok).toBe(true);
    await uploadDocument(st.db, st.e.config, st.e.s.eng1, st.e.s.stageA, 'Письмо о сроках (R13-04).pdf');
    expect(await notApplicable(st, c.id, 'Письмо о сроках не меняет комплект')).toBeGreaterThan(0);
    const fresh = await view(st, c.id, st.e.s.eng1);
    expect(fresh.gate.release!.ok).toBe(true);
    const stale = await release(st, shown, a.body.approval.id as string);
    expect(stale.status, stale.text).toBe(409);
    expect(stale.body.current.reason).toBe('composition_changed');
    const ok = await release(st, fresh, a.body.approval.id as string);
    expect(ok.status, ok.text).toBe(201);
  });
});

describe('R13-02 — причины решений наследуют закрытость предмета', () => {
  const LETTER = 'Заказчик требует скидку 27 процентов (вымышленное условие R13-02)';
  const RISK_REASON = 'SECRET-RISK-13: заказчик требует скидку 27 процентов';
  const HOLD_REASON = 'SECRET-HOLD-13: письмо о скидке учтено отдельно';
  const HOLD_REASON_2 = 'SECRET-HOLD-13B: второе письмо о скидке меняет условия';
  const MAIL = ['mail.read', 'mail.import', 'mail.link'];
  let box = '';
  let finding = '';

  const letter = async (messageId: string, text: string): Promise<void> => {
    const imported = await importEml(st.e.s.eng1, st.e.worker, box, eml({ messageId, subject: 'Условие', text }));
    await linkMail(st.e.s.eng1, imported.messageId!, st.e.s.tenderA, st.e.s.stageA);
  };

  beforeAll(async () => {
    box = await createMailbox(st.e.s.admin, 'r13-02@contractor.example.test', 'Ящик R13-02');
    for (const id of [st.e.s.ids.eng1, st.e.s.ids.manager]) await setMailAccess(st.e.s.admin, box, id, MAIL);
    const imported = await importEml(st.e.s.eng1, st.e.worker, box, eml({ messageId: 'r13-02-a@example.test', subject: 'Условие', text: LETTER }));
    await linkMail(st.e.s.eng1, imported.messageId!, st.e.s.tenderA, st.e.s.stageA);
    await fixScope(st.e.s.manager, st.e.s.stageA);
    const fragment = (await st.db.pool.query("SELECT id FROM evidence_fragment WHERE mail_message_revision_id = $1 AND origin = 'email_body' ORDER BY ordinal LIMIT 1", [imported.revisionId])).rows[0].id;
    finding = await critical('Условие письма не учтено (R13-02)', fragment);
  });

  it('карточка, журнал и удержания инженера без доступа к ящику — без причин; манифест и ZIP всех файлов — только при доступе к предметам решений', async () => {
    let c = await assembled(st);
    // События прошлых сценариев (документы тендера) — с нейтральной причиной; событие письма — с причиной о письме.
    const holds = await openHolds(st, c.id);
    const mailHold = holds.find((h) => h.event.type === 'communication_linked')!;
    const others = holds.filter((h) => h.id !== mailHold.id).map((h) => h.id);
    if (others.length > 0) {
      const r = await st.e.s.manager.post(`/release-candidates/${c.id}/holds/resolve`, { holdIds: others, resolution: 'not_applicable', reason: 'Документы тендера не меняют комплект' }, { headers: idem() });
      expect(r.status, r.text).toBe(200);
    }
    const mail = await st.e.s.manager.post(`/holds/${mailHold.id}/resolve`, { resolution: 'not_applicable', reason: HOLD_REASON }, { headers: { 'If-Match': mailHold.etag, ...idem() } });
    expect(mail.status, mail.text).toBe(200);
    expect(mail.body.reason).toBe(HOLD_REASON);
    c = await view(st, c.id);
    const item = c.gate.approve!.blockers.find((b) => b.code === 'CRITICAL_FINDINGS_OPEN')!.items.find((i) => i.subjectId === finding)!;
    const acc = await acceptRisk(st, c, { blockerCode: 'CRITICAL_FINDINGS_OPEN', subjectType: 'finding', subjectId: finding, subjectKey: item.subjectKey, reason: RISK_REASON });
    expect(acc.status, acc.text).toBe(201);
    await acceptAll(st, await view(st, c.id));
    c = await view(st, c.id);
    // Руководитель с доступом видит свои причины.
    expect(JSON.stringify(c)).toContain(RISK_REASON);

    const card = await st.e.s.eng2.get(`/release-candidates/${c.id}`);
    expect(card.status).toBe(200);
    expect(card.text).not.toContain(RISK_REASON);
    expect(card.text).not.toContain(HOLD_REASON);
    const restrictedItem = (card.body.gate.approve.blockers as { code: string; items: { subjectId: string; restricted: boolean; acceptance: unknown }[] }[])
      .find((b) => b.code === 'CRITICAL_FINDINGS_OPEN')!
      .items.find((i) => i.subjectId === finding)!;
    expect(restrictedItem.restricted).toBe(true);
    expect(restrictedItem.acceptance).not.toBeNull();
    const list = await st.e.s.eng2.get(`/stages/${st.e.s.stageA}/holds?candidateId=${c.id}`);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(HOLD_REASON);
    expect((list.body.items as { event: { type: string }; restricted: boolean }[]).find((h) => h.event.type === 'communication_linked')!.restricted).toBe(true);
    const history = await st.e.s.eng2.get(`/release-candidates/${c.id}/history`);
    expect(history.status).toBe(200);
    expect(history.text).not.toContain(RISK_REASON);
    expect(history.text).not.toContain(HOLD_REASON);

    const a = await approve(st, c);
    expect(a.status, a.text).toBe(200);
    const r = await release(st, await view(st, c.id, st.e.s.eng1), a.body.approval.id as string);
    expect(r.status, r.text).toBe(201);
    const id = r.body.release.id as string;
    const closed = await st.e.s.eng2.getBuffer(`/releases/${id}/manifest`);
    expect(closed.status).toBe(409);
    expect((closed.body as Buffer).toString('utf8')).not.toContain(RISK_REASON);
    expect((await st.e.s.eng2.getBuffer(`/releases/${id}/archive?set=all`)).status).toBe(409);
    expect((await st.e.s.eng2.getBuffer(`/releases/${id}/archive?set=customer`)).status).toBe(200);
    expect((await st.e.s.eng2.get(`/releases/${id}`)).body.manifestReadable).toBe(false);
    // Точная запись не переписывается: кто видит предметы всех решений — читает манифест с причинами.
    const open = await st.e.s.eng1.getBuffer(`/releases/${id}/manifest`);
    expect(open.status).toBe(200);
    expect((open.body as Buffer).toString('utf8')).toContain(RISK_REASON);
    expect((await st.e.s.eng1.get(`/releases/${id}`)).body.manifestReadable).toBe(true);
  });

  it('«влияет» по закрытому письму: причина не попадает в возврат, отзыв и журнал комплекта для инженера без доступа', async () => {
    const c = await readyToApprove();
    const a = await approve(st, c);
    expect(a.status, a.text).toBe(200);
    await letter('r13-02-b@example.test', 'Второе вымышленное условие R13-02');
    const hold = (await openHolds(st, c.id)).find((h) => h.event.type === 'communication_linked')!;
    const res = await st.e.s.manager.post(`/holds/${hold.id}/resolve`, { resolution: 'requires_new_candidate', reason: HOLD_REASON_2 }, { headers: { 'If-Match': hold.etag, ...idem() } });
    expect(res.status, res.text).toBe(200);
    const card = await st.e.s.eng2.get(`/release-candidates/${c.id}`);
    expect(card.status).toBe(200);
    expect(card.body.status).toBe('returned');
    expect(card.text).not.toContain(HOLD_REASON_2);
    const history = await st.e.s.eng2.get(`/release-candidates/${c.id}/history`);
    expect(history.text).not.toContain(HOLD_REASON_2);
    expect((await st.e.s.manager.get(`/release-candidates/${c.id}/history`)).text).toContain(HOLD_REASON_2);
  });

  it('руководитель без доступа к письму решение по удержанию его события не принимает (409 restricted_event); с доступом — принимает', async () => {
    await letter('r13-02-c@example.test', 'Третье вымышленное условие R13-02');
    const c = await assembled(st);
    const holds = await openHolds(st, c.id);
    await setMailAccess(st.e.s.admin, box, st.e.s.ids.manager, []);
    try {
      const blind = await st.e.s.manager.post(`/release-candidates/${c.id}/holds/resolve`, { holdIds: holds.map((h) => h.id), resolution: 'not_applicable', reason: 'Решение без чтения письма' }, { headers: idem() });
      expect(blind.status, blind.text).toBe(409);
      expect(blind.body.current.reason).toBe('restricted_event');
      expect((await openHolds(st, c.id)).length).toBe(holds.length);
    } finally {
      await setMailAccess(st.e.s.admin, box, st.e.s.ids.manager, MAIL);
    }
    expect(await notApplicable(st, c.id, 'Письмо прочитано: комплект не меняет')).toBe(holds.length);
  });
});

describe('R13-03 — «влияет» исключает отправку выпуска навсегда', () => {
  it('исход элемента партии после «влияет» не возвращает выпуск в «готов»', async () => {
    const c = await readyToApprove();
    const a = await approve(st, c);
    expect(a.status, a.text).toBe(200);
    const r = await release(st, await view(st, c.id, st.e.s.eng1), a.body.approval.id as string);
    expect(r.status, r.text).toBe(201);
    const releaseId = r.body.release.id as string;
    const state = async () => (await st.e.s.eng1.get(`/releases/${releaseId}`)).body.sendReadiness as { state: string; sendable: boolean };
    expect((await state()).state).toBe('ready');
    const up = await upload(st.e.s.eng1, 'повреждённый (R13-03).zip', buildZip([{ name: 'Повреждён.pdf', data: Buffer.from('повреждённый PDF R13-03') }]));
    expect(up.status, up.text).toBe(202);
    await drain(st.e.worker);
    const batch = (await st.e.s.eng1.get(`/imports/${up.body.id}`)).body;
    expect(batch.status).toBe('completed_with_errors');
    expect((await state()).state).toBe('held');
    const hold = (await openHolds(st, c.id)).find((h) => h.event.type === 'import_accepted')!;
    const res = await st.e.s.manager.post(`/holds/${hold.id}/resolve`, { resolution: 'requires_new_candidate', reason: 'Повреждённый файл мог быть документом заказчика' }, { headers: { 'If-Match': hold.etag, ...idem() } });
    expect(res.status, res.text).toBe(200);
    expect((await state()).state).toBe('excluded');
    for (const item of batch.items as { id: string; rowVersion: number }[]) {
      const ok = await st.e.s.manager.post(`/import-items/${item.id}/resolve`, { resolution: 'not_applicable', reason: 'Черновик, не документ заказчика' }, {
        headers: { 'If-Match': `"${item.id}:${item.rowVersion}"`, ...idem() },
      });
      expect(ok.status, ok.text).toBe(200);
    }
    // Событие теперь покрыто, но решение «влияет» действует: исправление — только новым комплектом.
    expect(await state()).toMatchObject({ state: 'excluded', sendable: false });
    expect((await view(st, c.id, st.e.s.eng1)).release!.sendReadiness.state).toBe('excluded');
  });
});

describe('R13-01 — устаревший вход прогона проверок', () => {
  it('после прогона подтверждено требование: прогон устарел, согласование и выпуск — 409 REVIEW_OUTDATED, риск не принимается, БД отвергает прямые записи; новый прогон — согласуется', async () => {
    // Согласован до изменения реестра — выпуск после изменения тоже запрещён.
    const before = await readyToApprove();
    const approved = await approve(st, before);
    expect(approved.status, approved.text).toBe(200);
    // Третье требование по уже обработанному фрагменту ТЗ: новых документа, снимка и расчёта нет.
    await requirementOf(st, 'Штукатурка откосов окон (R13-01)', await tzFragment(TZ.plaster));
    const run = await st.e.s.eng1.get(`/review-runs/${st.run.id}`);
    expect(run.body.freshness.outdated).toBe(true);

    // Согласованный до изменения — не выпускается (до сборки нового комплекта, который его заменит).
    const shown = await view(st, before.id, st.e.s.eng1);
    expect(codes(shown.gate.release)).toEqual(['REVIEW_OUTDATED']);
    const rel = await release(st, shown, approved.body.approval.id as string);
    expect(rel.status, rel.text).toBe(409);
    expect(codes(rel.body as never)).toEqual(['REVIEW_OUTDATED']);
    const row = (await st.db.pool.query('SELECT manifest_blob_sha256 AS b FROM release_candidate WHERE id = $1', [before.id])).rows[0].b as string;
    expect(
      await probe(async (q) => {
        await q.query(
          `INSERT INTO release (candidate_id, approval_id, tender_id, stage_id, mode, input_version, content_hash, release_manifest_blob_sha256, release_manifest_sha256, gate, released_by)
           VALUES ($1, $2, $3, $4, 'test', 0, $5, $6, $6, '{}', $7)`,
          [before.id, approved.body.approval.id, st.e.s.tenderA, st.e.s.stageA, before.contentHash, row, st.e.s.ids.eng1],
        );
        await q.query("UPDATE release_candidate SET status = 'released', row_version = row_version + 1 WHERE id = $1", [before.id]);
      }),
    ).toBe('23514');

    let c = await readyToApprove();
    expect(codes(c.gate.approve)).toEqual(['REVIEW_OUTDATED']);
    const blocker = c.gate.approve!.blockers.find((b) => b.code === 'REVIEW_OUTDATED')!;
    expect(blocker.acceptable).toBe(false);
    const risk = await acceptRisk(st, c, { blockerCode: 'REVIEW_OUTDATED', subjectType: 'review_run', subjectId: blocker.items[0]!.subjectId, reason: 'Проверки достаточно' });
    expect(risk.status, risk.text).toBe(409);
    expect(risk.body.current.reason).toBe('risk_not_acceptable');
    const refused = await approve(st, c);
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.code).toBe('BLOCKER_PRESENT');
    expect(codes(refused.body as never)).toEqual(['REVIEW_OUTDATED']);
    expect(
      await probe(async (q) => {
        await q.query("INSERT INTO approval (candidate_id, tender_id, stage_id, candidate_content_hash, input_version, gate, approved_by) VALUES ($1, $2, $3, $4, 0, '{}', $5)", [
          c.id, st.e.s.tenderA, st.e.s.stageA, c.contentHash, st.e.s.ids.manager,
        ]);
        await q.query("UPDATE release_candidate SET status = 'approved', row_version = row_version + 1 WHERE id = $1", [c.id]);
      }),
    ).toBe('23514');

    // Новый прогон по изменённому реестру; прежний вход сохранён (прогон остаётся устаревшим).
    const started = await st.e.s.eng1.post(`/stages/${st.e.s.stageA}/review-runs`, {}, { headers: idem() });
    expect(started.status, started.text).toBe(201);
    await drain(st.e.worker);
    // Свежесть по содержимому этапа (реестр, покрытие, вопросы, решения); документы прошлых сценариев после снимка
    // области — отдельная причина свежести, её закрывают удержания и решения «не влияет».
    const CONTENT = 'после проверки изменились реестр требований, покрытие или записи этапа';
    const reasons = async (id: string): Promise<string[]> => (await st.e.s.eng1.get(`/review-runs/${id}`)).body.freshness.reasons as string[];
    expect(await reasons(started.body.id as string)).not.toContain(CONTENT);
    expect(await reasons(st.run.id)).toContain(CONTENT);
    // S12-01: правка полей приложения прогон не устаревает.
    await filledDraft(st, 'letter', 'Письмо КП после нового прогона');
    expect(await reasons(started.body.id as string)).not.toContain(CONTENT);
    c = await readyToApprove();
    expect(codes(c.gate.approve)).toEqual([]);
    const ok = await approve(st, c);
    expect(ok.status, ok.text).toBe(200);
  });
});
