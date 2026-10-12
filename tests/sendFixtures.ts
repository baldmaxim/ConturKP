// Фикстуры этапа 15 (D-035): боевой выпуск на поддельных данных — ревизия расчёта verified по контрактной фикстуре X-01,
// правило итога КП фикстуры, шаблоны без отметки «демо» (в установке таких данных нет: Q-01/X-01, Q-05, Q-08 в силе) —
// и синтетические отправленные письма EML в зарегистрированном ящике портала. MailHub не участвует (BLOCKED_EXTERNAL).
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { BlobStore } from '../packages/storage/src/index.ts';
import { acceptAll, approve, assembled, buildStage13, notApplicable, release, view, type ICandidate13, type IStage13, type IStage13Options } from './approvalFixtures.ts';
import { drain, idem, type TestClient } from './helpers.ts';
import { createMailbox, eml, importEml, linkMail, octet, setMailAccess, type IEmlAttachment } from './mailFixtures.ts';

export interface IStage15 extends IStage13 {
  mailbox: string;
}

export interface IReleased {
  candidate: ICandidate13;
  releaseId: string;
  releasedAt: string;
}

// Этап с данными боевого режима и ящиком «Отправленные»: инженер 1 читает, импортирует и связывает; руководитель читает.
export const buildStage15 = async (o: IStage13Options = {}): Promise<IStage15> => {
  const st = await buildStage13({ production: true, ...o });
  const mailbox = await createMailbox(st.e.s.admin, 'tender-out@contractor.example.test', 'Тендерный отдел');
  await setMailAccess(st.e.s.admin, mailbox, st.e.s.ids.eng1, ['mail.read', 'mail.import', 'mail.link']);
  await setMailAccess(st.e.s.admin, mailbox, st.e.s.ids.manager, ['mail.read']);
  return { ...st, mailbox };
};

// Комплект до выпуска через настоящие команды: сборка на worker, решения по удержаниям, принятие рисков, согласование, выпуск.
export const released = async (st: IStage13, mode: 'test' | 'production' = 'production', draftIds?: string[]): Promise<IReleased> => {
  let c = await assembled(st, { mode, ...(draftIds ? { draftIds } : {}) });
  await notApplicable(st, c.id);
  c = await view(st, c.id);
  await acceptAll(st, c);
  c = await view(st, c.id);
  const a = await approve(st, c);
  expect(a.status, a.text).toBe(200);
  c = await view(st, c.id, st.e.s.eng1);
  const r = await release(st, c, a.body.approval.id as string);
  expect(r.status, r.text).toBe(201);
  return { candidate: await view(st, c.id), releaseId: r.body.release.id as string, releasedAt: r.body.release.releasedAt as string };
};

// Тест, оборванный отказом или лимитом времени, мог оставить сборку комплекта в работе: следующий тест получил бы
// «комплект собирается» и чужие записи (R15-04). Ждём, пока очередь заданий опустеет.
export const settle = async (st: IStage13 | undefined): Promise<void> => {
  if (!st) return;
  for (let i = 0; i < 600; i += 1) {
    await drain(st.e.worker);
    const busy = await st.e.db.pool.query("SELECT 1 FROM job WHERE status IN ('queued', 'running') LIMIT 1");
    if (busy.rowCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const blob = (st: IStage13, sha256: string): Buffer => readFileSync(new BlobStore(st.e.config.storageRoot).pathOf(sha256));

// Файлы комплекта для заказчика как вложения письма (точные байты выпуска).
export const kitAttachments = (st: IStage13, c: ICandidate13): IEmlAttachment[] =>
  c.files.filter((f) => f.audience === 'customer').map((f) => ({ name: f.path, type: 'application/octet-stream', bytes: blob(st, f.sha256) }));

export const internalAttachments = (st: IStage13, c: ICandidate13): IEmlAttachment[] =>
  c.files.filter((f) => f.audience === 'internal').map((f) => ({ name: f.path, type: 'application/octet-stream', bytes: blob(st, f.sha256) }));

let letterNo = 0;

export interface ISentLetter {
  messageId: string;
  revisionId: string;
  header: string;
}

// Отправленное письмо: импорт EML в ящик с направлением «исходящее» и связь с тендером (событие барьера этапа).
export const sentLetter = async (
  st: IStage15,
  o: { attachments: IEmlAttachment[]; messageId?: string | null; date?: Date; folder?: string; mailbox?: string; subject?: string; client?: TestClient; link?: boolean; direction?: string; text?: string },
): Promise<ISentLetter> => {
  letterNo += 1;
  const header = o.messageId === undefined ? `kp-${letterNo}-${Math.random().toString(36).slice(2)}@contractor.example.test` : (o.messageId ?? '');
  const raw = eml({
    messageId: o.messageId === null ? null : header,
    subject: o.subject ?? 'Коммерческое предложение',
    from: 'Тендерный отдел <tender-out@contractor.example.test>',
    to: 'Заказчик <customer@example.test>',
    date: (o.date ?? new Date(Date.now() + 1000)).toUTCString(),
    text: o.text ?? 'Направляем коммерческое предложение.',
    attachments: o.attachments,
  });
  const client = o.client ?? st.e.s.eng1;
  const done = await importEml(client, st.e.worker, o.mailbox ?? st.mailbox, raw, { direction: o.direction ?? 'outbound', ...(o.folder ? { folder: o.folder } : {}) });
  expect(done.status, JSON.stringify(done)).toBe('done');
  if (o.link !== false) await linkMail(client, done.messageId!, st.e.s.tenderA, st.e.s.stageA);
  return { messageId: done.messageId!, revisionId: done.revisionId!, header };
};

export const registerSend = (st: IStage13, releaseId: string, body: Record<string, unknown>, client: TestClient = st.e.s.eng1, key: Record<string, string> = idem()) =>
  client.post(`/releases/${releaseId}/send-events`, body, { headers: key });

export const registerByMail = (st: IStage13, releaseId: string, revisionId: string, client: TestClient = st.e.s.eng1) =>
  registerSend(st, releaseId, { evidence: { kind: 'mail_message', mailMessageRevisionId: revisionId } }, client);

export const uploadEvidence = async (st: IStage13, releaseId: string, bytes: Buffer, name: string, client: TestClient = st.e.s.eng1): Promise<string> => {
  const r = await client.post(`/releases/${releaseId}/send-evidence?${new URLSearchParams({ name }).toString()}`, bytes, { headers: { ...octet, ...idem() } });
  expect(r.status, r.text).toBe(201);
  return r.body.uploadId as string;
};

export interface ISendView {
  id: string;
  seq: number;
  channel: string;
  sentAt: string;
  status: string;
  attachmentCheck: string;
  extrasAccepted: boolean;
  counted: boolean;
  repeat: boolean;
  evidence: {
    kind: string;
    mail: { restricted: boolean; messageId: string | null; subject: string | null; from: string | null; recipients: string[]; copies: { messageId: string; mailboxName: string; folder: string | null }[] } | null;
    file: { fileName: string; sha256: string } | null;
  };
  recipients: string[];
  note: string | null;
  check: { kitFiles: number; missing?: { path: string }[]; extras?: { unknown: number; inline: number; internal: number; otherRelease: number }; extrasOnly?: boolean };
  files: { ordinal: number; sha256: string; class: string; kitPath: string | null; otherReleaseSeq: number | null; inline: boolean; fileName: string | null }[];
  decisions: { action: string; reason: string | null; restricted: boolean }[];
  etag: string;
  actions: { acceptExtras: boolean };
}

export interface ISendList {
  items: ISendView[];
  incidents: { id: string; kind: string; description: string | null; restricted: boolean }[];
  summary: { state: string; events: number; counted: number; disputed: number; incidents: number; testRelease: boolean; readiness: { state: string; events: { seq: number; type: string }[] }; provesReceipt: boolean };
  warnings: string[];
  mailhub: { status: string };
  can: { register: boolean; registerBlockedBy: string | null; registerIncident: boolean; acceptExtras: boolean };
}

export const sends = async (st: IStage13, releaseId: string, client: TestClient = st.e.s.eng1): Promise<ISendList> => {
  const r = await client.get(`/releases/${releaseId}/send-events`);
  expect(r.status, r.text).toBe(200);
  return r.body as ISendList;
};
