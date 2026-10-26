// S18-25: минимальный снимок источника по контракту 0017/0018 на схеме 0040.
// Современный mail worker зависит от 0045 и не может готовить историческую БД.
// Все INSERT выполняются ролью приложения, со штатными FK и охранниками создания ревизии.
import { Readable } from 'node:stream';
import { sha256Hex } from '../packages/core/src/index.ts';
import { BlobStore } from '../packages/storage/src/index.ts';
import { buildScenario, makeApp, testConfig, type IScenario, type ITestDb } from './helpers.ts';
import { createMailbox, eml, setMailAccess } from './mailFixtures.ts';
import { issueToken, startMcp, type IMcpEndpoint } from './mcpFixtures.ts';
import { fixScope, seedEvidenceRun, setWorkingSet } from './searchFixtures.ts';
import { fakePdf } from './zip.ts';

export interface ILegacy40QuestionStage {
  db: ITestDb; s: IScenario; endpoint: IMcpEndpoint; mailFragment: string; proposer: { id: string; token: string };
}

export const buildLegacy40QuestionStage = async (db: ITestDb): Promise<ILegacy40QuestionStage> => {
  const config = testConfig(), app = makeApp(db, undefined, config), s = await buildScenario(db, app);
  const box = await createMailbox(s.admin, 'legacy40@example.test');
  await setMailAccess(s.admin, box, s.ids.eng1!, ['mail.read', 'mail.import', 'mail.link']);
  await setMailAccess(s.admin, box, s.ids.manager!, ['mail.read', 'mail.link']);
  const text = 'Закрытое письмо основания вопроса на исторической схеме 0040';
  const raw = eml({ messageId: 'legacy40-question@example.test', subject: 'Историческое основание', text });
  const store = new BlobStore(config.storageRoot); await store.ensureDirs();
  const blob = await store.putStream(Readable.from([raw]), config.limits.maxUploadBytes);
  const documentBlob = await store.putStream(Readable.from([fakePdf('Legacy 0040 tender document')]), config.limits.maxUploadBytes);
  const client = await db.pool.connect(); let mailFragment: string, documentRevision: string;
  try {
    await client.query('BEGIN');
    // SQL намеренно зафиксирован в формате 0040: новые таблицы и helpers здесь не используются.
    await client.query("INSERT INTO blob(sha256,size_bytes,media_type,storage_key) VALUES($1,$2,'message/rfc822',$3) ON CONFLICT(sha256) DO NOTHING", [blob.sha256, blob.sizeBytes, blob.storageKey]);
    const communication = (await client.query<{id:string}>("INSERT INTO mail_communication(group_key) VALUES('legacy40-question') RETURNING id")).rows[0]!.id;
    const message = (await client.query<{id:string}>("INSERT INTO mail_message(mailbox_id,communication_id,identity_kind,identity_value,created_by) VALUES($1,$2,'message_id','legacy40-question@example.test',$3) RETURNING id", [box, communication, s.ids.eng1])).rows[0]!.id;
    const revision = (await client.query<{id:string}>("INSERT INTO mail_message_revision(message_id,seq,raw_blob_sha256,message_id_header,subject,direction,source,body_text_sha256,imported_by) VALUES($1,1,$2,'legacy40-question@example.test','Историческое основание','inbound','eml_import',$3,$4) RETURNING id", [message, blob.sha256, sha256Hex(text), s.ids.eng1])).rows[0]!.id;
    mailFragment = (await client.query<{id:string}>(`INSERT INTO evidence_fragment(source_unit_type,source_unit_id,mail_message_revision_id,origin,fragment_kind,fragment_key,ordinal,text,text_sha256,part_index,part_total,locator)
      VALUES('mail_message_revision',$1,$1,'email_body','text_block','b1',1,$2,$3,0,1,'{"kind":"mail_body","block":1,"quoted":false}') RETURNING id`, [revision, text, sha256Hex(text)])).rows[0]!.id;
    await client.query('INSERT INTO mail_message_tender(message_id,tender_id,stage_id,linked_by,updated_by) VALUES($1,$2,$3,$4,$4)', [message, s.tenderA, s.stageA, s.ids.eng1]);
    await client.query("INSERT INTO blob(sha256,size_bytes,media_type,storage_key) VALUES($1,$2,'application/pdf',$3) ON CONFLICT(sha256) DO NOTHING", [documentBlob.sha256, documentBlob.sizeBytes, documentBlob.storageKey]);
    const document = (await client.query<{id:string}>("INSERT INTO document(tender_id,title,name_key,doc_type) VALUES($1,'Историческое ТЗ.pdf','историческое тз.pdf','tz') RETURNING id", [s.tenderA])).rows[0]!.id;
    documentRevision = (await client.query<{id:string}>('INSERT INTO document_revision(document_id,tender_id,blob_sha256,revision_seq,registered_by) VALUES($1,$2,$3,1,$4) RETURNING id', [document,s.tenderA,documentBlob.sha256,s.ids.eng1])).rows[0]!.id;
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await seedEvidenceRun(db.pool, documentRevision, { pages: [{ blocks: ['Историческое ТЗ'] }], storageRoot: config.storageRoot });
  await setWorkingSet(s.eng1, s.stageA, [documentRevision], true);
  await fixScope(s.eng1, s.stageA);
  return { db, s, mailFragment, endpoint: await startMcp(app), proposer: await issueToken(s.eng1, { propose: true }) };
};
