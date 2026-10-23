// Явное подключение согласованной общей области MailHub; повтор сохраняет курсор и идентичность писем.
// --admin <логин> --mailboxes <slug,slug,...>. Секрет — только MAILHUB_TOKEN в окружении.
import { MailHubReader } from '../../packages/adapters/src/index.ts';
import { loadConfig } from '../../packages/config/src/index.ts';
import { globalCapabilities } from '../../packages/core/src/index.ts';
import {
  createMailbox,
  createPool,
  loadAccessContext,
  setMailAccess,
  withTransaction,
  writeAudit,
} from '../../packages/db/src/index.ts';
import { argValue } from '../cli.ts';

const main = async (): Promise<void> => {
  const config = loadConfig();
  const login = argValue('admin');
  const expected = (argValue('mailboxes') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .sort();
  if (!login || !expected.length || !config.mailhub)
    throw new Error('Нужны --admin, --mailboxes, MAILHUB_URL и MAILHUB_TOKEN');
  const api = new MailHubReader({
    ...config.mailhub,
    maxEmlBytes: config.mail.maxEmlBytes,
  });
  const boxes = await api.mailboxes();
  if (
    JSON.stringify(boxes.map((x) => x.slug).sort()) !== JSON.stringify(expected)
  )
    throw new Error('Ящики токена не совпадают с согласованным списком');
  const pool = createPool(config.databaseUrl, 2);
  try {
    const result = await withTransaction(pool, async (db) => {
      const actor = (
        await db.query<{ id: string }>(
          "SELECT id FROM app_user WHERE login=$1 AND status='active'",
          [login],
        )
      ).rows[0];
      if (!actor) throw new Error('Действующий администратор не найден');
      const ctx = await loadAccessContext(db, actor.id, 'mailhub-connect');
      if (!ctx || !globalCapabilities(ctx.roles).includes('admin.mailbox'))
        throw new Error('Нужны права администратора почты');
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtext('mailhub.connect'),hashtext($1))",
        [api.sourceKey],
      );
      const created = await createMailbox(db, {
        system: 'mailhub',
        externalAccountId: api.sourceKey,
        displayName: 'MailHub — общая почта',
        createdBy: actor.id,
      });
      const mailboxId = 'id' in created ? created.id : created.conflict;
      await setMailAccess(db, {
        mailboxId,
        userId: actor.id,
        capabilities: ['mail.read', 'mail.import', 'mail.link'],
        actorId: actor.id,
      });
      await db.query(
        `INSERT INTO mailhub_connection(source_key,mailbox_id,actor_user_id,allowed_mailboxes) VALUES($1,$2,$3,$4::uuid[])
        ON CONFLICT(source_key) DO UPDATE SET enabled=true,actor_user_id=excluded.actor_user_id,allowed_mailboxes=excluded.allowed_mailboxes`,
        [api.sourceKey, mailboxId, actor.id, boxes.map((x) => x.id)],
      );
      await writeAudit(db, {
        actorUserId: actor.id,
        principalKind: 'system',
        action: 'mailhub.connect',
        entityType: 'mailbox',
        entityId: mailboxId,
        outcome: 'allowed',
        details: {
          sourceKey: api.sourceKey,
          mailboxes: expected,
          history: 'all',
          aggregation: 'logical_mailhub_item',
        },
      });
      return { mailboxId, sourceKey: api.sourceKey, mailboxes: expected };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
};
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Подключение MailHub не выполнено',
  );
  process.exitCode = 1;
});
