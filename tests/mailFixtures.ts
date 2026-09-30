// Фикстуры почтового контура (этап 07): синтетические письма EML, ящики, выдачи, импорт через API и
// разбор worker. Письма, адреса и вложения выдуманы; реальной переписки в тестах нет.
import { expect } from 'vitest';
import type { WorkerRuntime } from '../apps/worker/src/runtime.ts';
import { drain, idem, type TestClient } from './helpers.ts';

export const octet = { 'Content-Type': 'application/octet-stream' };

const b64 = (s: string | Buffer): string =>
  (typeof s === 'string' ? Buffer.from(s, 'utf8') : s)
    .toString('base64')
    .replace(/.{76}/gu, '$&\r\n');

const encodedWord = (s: string): string => (/^[\x20-\x7e]*$/u.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export interface IEmlAttachment {
  name: string;
  type: string;
  bytes: Buffer;
  inline?: boolean;
}

export interface IEmlSpec {
  messageId?: string | null;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: IEmlAttachment[];
  extraHeaders?: string[];
}

// Письмо RFC 5322 с телом в base64 (кириллица) и вложениями multipart/mixed.
export const eml = (o: IEmlSpec): Buffer => {
  const headers = [
    `From: ${o.from ?? 'Заказчик <customer@example.test>'}`,
    `To: ${o.to ?? 'tender@contractor.example.test'}`,
    ...(o.cc ? [`Cc: ${o.cc}`] : []),
    `Subject: ${encodedWord(o.subject ?? 'Без темы')}`,
    `Date: ${o.date ?? 'Tue, 01 Sep 2026 10:00:00 +0500'}`,
    ...(o.messageId === null ? [] : [`Message-ID: <${o.messageId ?? `${Math.random().toString(36).slice(2)}@example.test`}>`]),
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    ...(o.extraHeaders ?? []),
    'MIME-Version: 1.0',
  ];
  const textPart = (type: string, body: string) => [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', b64(body)].join('\r\n');
  const body = o.html !== undefined ? textPart('text/html', o.html) : textPart('text/plain', o.text ?? '');
  if (!o.attachments || o.attachments.length === 0) return Buffer.from([...headers, body].join('\r\n'), 'utf8');
  const boundary = `b-${Math.random().toString(36).slice(2)}`;
  const parts = [
    body,
    ...o.attachments.map((a) =>
      [
        `Content-Type: ${a.type}; name="${encodedWord(a.name)}"`,
        `Content-Disposition: ${a.inline ? 'inline' : 'attachment'}; filename="${encodedWord(a.name)}"`,
        'Content-Transfer-Encoding: base64',
        '',
        b64(a.bytes),
      ].join('\r\n'),
    ),
  ];
  return Buffer.from(
    [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts.flatMap((p) => [`--${boundary}`, p]), `--${boundary}--`, ''].join('\r\n'),
    'utf8',
  );
};

export const etagOf = async (client: TestClient, path: string): Promise<string> => {
  const r = await client.get(path);
  expect(r.status, r.text).toBe(200);
  return r.headers.etag as string;
};

export const createMailbox = async (admin: TestClient, externalAccountId: string, displayName = externalAccountId, system = 'manual'): Promise<string> => {
  const r = await admin.post('/mailboxes', { system, externalAccountId, displayName }, { headers: idem() });
  expect(r.status, r.text).toBe(201);
  return r.body.id as string;
};

export const setMailAccess = async (admin: TestClient, mailboxId: string, userId: string, capabilities: string[]) => {
  const r = await admin.put(`/mailboxes/${mailboxId}/access/${userId}`, { capabilities }, { headers: { 'If-Match': await etagOf(admin, `/mailboxes/${mailboxId}`) } });
  expect(r.status, r.text).toBe(200);
  return r;
};

export const postEml = (client: TestClient, mailboxId: string, raw: Buffer, q: Record<string, string> = {}, name = 'letter.eml') =>
  client.post(`/mailboxes/${mailboxId}/imports?${new URLSearchParams({ name, ...q }).toString()}`, raw, { headers: { ...octet, ...idem() } });

// Импорт и разбор: команда 202, worker доводит импорт до исхода. Возвращает исход импорта.
export const importEml = async (client: TestClient, worker: WorkerRuntime, mailboxId: string, raw: Buffer, q: Record<string, string> = {}) => {
  const r = await postEml(client, mailboxId, raw, q);
  expect(r.status, r.text).toBe(202);
  await drain(worker);
  const done = await client.get(`/mail-imports/${r.body.id}`);
  expect(done.status, done.text).toBe(200);
  return done.body as { id: string; status: string; messageId: string | null; revisionId: string | null; createdRevision: boolean | null; failureCode: string | null };
};

export const linkMail = async (client: TestClient, messageId: string, tenderId: string, stageId: string | null = null) => {
  const r = await client.post(`/mail-messages/${messageId}/tender-links`, { tenderId, ...(stageId ? { stageId } : {}) }, { headers: idem() });
  expect([200, 201], r.text).toContain(r.status);
  return r.body;
};

export const unlinkMail = async (client: TestClient, messageId: string, tenderId: string) => {
  const r = await client.post(`/mail-messages/${messageId}/tender-links/${tenderId}/unlink`, {}, { headers: idem() });
  expect(r.status, r.text).toBe(200);
  return r.body;
};

export const postManifest = (client: TestClient, tenderId: string, kind: 'qa' | 'negotiation', manifest: unknown, q: Record<string, string> = {}) =>
  client.post(`/tenders/${tenderId}/${kind}-imports?${new URLSearchParams({ name: `${kind}.json`, ...q }).toString()}`, Buffer.from(JSON.stringify(manifest), 'utf8'), {
    headers: { ...octet, ...idem() },
  });

export const qaManifest = (items: { no: string; question: string; answer?: string | null; status?: string }[], thread = 'Q-1') => ({
  format: 'kontur.qa.v1',
  threads: [
    {
      externalRef: thread,
      title: 'Разъяснения документации',
      items: items.map((i) => ({ no: i.no, question: i.question, answer: i.answer ?? null, status: i.status ?? (i.answer ? 'answered' : 'open') })),
    },
  ],
});

export const negotiationManifest = (revision: string, segments: { no: number; speaker: string; kind?: 'speech' | 'hint'; text: string }[], sessionId = 'N-1') => ({
  format: 'kontur.negotiation.v1',
  session: { externalId: sessionId, title: 'Переговоры по цене', startedAt: '2026-09-02T09:00:00+05:00', audio: { ref: 'audio://negotiations/N-1.ogg', sha256: null } },
  participants: [
    { speakerLabel: 'S1', name: 'Представитель заказчика', side: 'customer' },
    { speakerLabel: 'S2', name: 'Инженер подрядчика', side: 'contractor' },
  ],
  transcript: {
    revision,
    segments: segments.map((s, i) => ({ no: s.no, speakerLabel: s.speaker, startMs: i * 10_000, endMs: i * 10_000 + 8_000, kind: s.kind ?? 'speech', text: s.text })),
  },
});

// ---------------------------------------------------------------- Сценарий почтовой области поиска

// Уникальные маркеры: по ним видно, откуда пришёл фрагмент (утечка — любое их появление).
export const MARK = {
  m1: 'ЖЕЛЕЗОБЕТОН-7741 гидроизоляция фундаментной плиты согласована заказчиком',
  m1Quote: 'ранее предлагали битумную мастику',
  att: 'СПЕЦМАРКА-ВЛОЖЕНИЯ-5521',
  m2: 'КЛИНКЕР-3390 облицовка фасада общая для двух тендеров',
  m3: 'ПЕСКОБЕТОН-6620 стяжка пола только тендера Б',
  sib: 'СИБЛИНГ-4410 копия письма в двух ящиках',
  tenderDoc: 'Техническое задание тендера А: гидроизоляция фундамента обмазочная',
};

export interface IMailScope {
  boxA: string;
  boxB: string;
  m1: string;
  m1Revision: string;
  m2: string;
  m3: string;
  sibA: string;
  sibB: string;
  attRevision: string;
  attRun: string;
  tenderDoc: string;
}

// Ящик A: eng1 (чтение, импорт, связь), manager (чтение, связь). Ящик B: eng3 (чтение, импорт, связь).
// M1 (A) связано с тендером A и этапом A, у него CSV-вложение; M2 (A) — с тендерами A и B; M3 (B) — только с B;
// копия одного письма (тот же Message-ID) в ящиках A и B — связь только у копии B с тендером B.
export const buildMailScope = async (
  s: { admin: TestClient; manager: TestClient; eng1: TestClient; eng3: TestClient; ids: Record<string, string>; tenderA: string; tenderB: string; stageA: string; stageB: string },
  worker: WorkerRuntime,
  uploadTenderDoc: () => Promise<string>,
  seedRun: (revisionId: string, text: string) => Promise<string>,
): Promise<IMailScope> => {
  const boxA = await createMailbox(s.admin, 'a@contractor.example.test', 'Ящик А');
  const boxB = await createMailbox(s.admin, 'b@contractor.example.test', 'Ящик Б');
  await setMailAccess(s.admin, boxA, s.ids.eng1!, ['mail.read', 'mail.import', 'mail.link']);
  await setMailAccess(s.admin, boxA, s.ids.manager!, ['mail.read', 'mail.link']);
  await setMailAccess(s.admin, boxB, s.ids.eng3!, ['mail.read', 'mail.import', 'mail.link']);
  const csv = Buffer.from(`Позиция;Примечание\nГидроизоляция;${MARK.att}\n`, 'utf8');
  const m1 = await importEml(s.eng1, worker, boxA, eml({ messageId: 'm1@example.test', subject: 'Гидроизоляция', text: `${MARK.m1}\n\n> ${MARK.m1Quote}\n`, attachments: [{ name: 'ведомость.csv', type: 'text/csv', bytes: csv }] }));
  const m2 = await importEml(s.eng1, worker, boxA, eml({ messageId: 'm2@example.test', subject: 'Фасад', text: MARK.m2 }));
  const m3 = await importEml(s.eng3, worker, boxB, eml({ messageId: 'm3@example.test', subject: 'Стяжка', text: MARK.m3 }));
  const sibling = eml({ messageId: 'sib@example.test', subject: 'Копия', text: MARK.sib });
  const sibA = await importEml(s.eng1, worker, boxA, sibling);
  const sibB = await importEml(s.eng3, worker, boxB, sibling);
  await linkMail(s.eng1, m1.messageId!, s.tenderA, s.stageA);
  await linkMail(s.eng1, m2.messageId!, s.tenderA);
  await linkMail(s.manager, m2.messageId!, s.tenderB);
  await linkMail(s.eng3, m3.messageId!, s.tenderB);
  await linkMail(s.eng3, sibB.messageId!, s.tenderB);
  // Вложение распознаётся общим путём 05a (автопроход CSV) и явно включается в состав этапа A.
  await worker.scheduleLocalRecognition();
  await drain(worker);
  const detail = await s.eng1.get(`/mail-messages/${m1.messageId}`);
  const att = detail.body.current.attachments[0] as { documentRevisionId: string; runStatus: string };
  expect(att.runStatus).toBe('complete');
  const run = await s.eng1.get(`/document-revisions/${att.documentRevisionId}/recognition-runs`);
  expect(run.status, run.text).toBe(200);
  const tenderDoc = await uploadTenderDoc();
  await seedRun(tenderDoc, MARK.tenderDoc);
  return {
    boxA,
    boxB,
    m1: m1.messageId!,
    m1Revision: m1.revisionId!,
    m2: m2.messageId!,
    m3: m3.messageId!,
    sibA: sibA.messageId!,
    sibB: sibB.messageId!,
    attRevision: att.documentRevisionId,
    attRun: (run.body.items as { id: string }[])[0]!.id,
    tenderDoc,
  };
};
