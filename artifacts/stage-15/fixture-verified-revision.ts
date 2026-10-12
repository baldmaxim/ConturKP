// Этап 15, проверка интерфейса и smoke: данные, с которыми боевой комплект проходит матрицу блокеров, — ПОДДЕЛЬНЫЕ.
// Ревизия расчёта verified записывается доменной функцией по контрактной фикстуре X-01 (в продукте адаптера ревизий
// TenderHub нет — BLOCKED_EXTERNAL) с правилом итога КП фикстуры (Q-05 владельцем не закрыт). Содержимое — то же, что у
// последней выгрузки поддельного TenderHub. Блокеры не отключаются; в установке такие данные появиться не могут.
// Запуск: node artifacts/stage-15/fixture-verified-revision.ts <stageId> <externalTenderId> → печатает ID ревизии.
import { runPortalCapture, TenderHubApiSource, TenderHubHttpClient } from '../../packages/adapters/src/index.ts';
import { calculationContentHash, type ICalcContent } from '../../packages/core/src/index.ts';
import { createPool, primaryCalculationSource, recordSourceRevision, withTransaction } from '../../packages/db/src/index.ts';

const [stageId, externalTenderId] = process.argv.slice(2);
if (!stageId || !externalTenderId || !process.env.DATABASE_URL || !process.env.TENDERHUB_URL || !process.env.TENDERHUB_API_KEY) {
  console.error('нужны: <stageId> <externalTenderId>, DATABASE_URL, TENDERHUB_URL, TENDERHUB_API_KEY');
  process.exitCode = 2;
} else if (!/test/u.test(new URL(process.env.DATABASE_URL).pathname)) {
  console.error('фикстура пишет только в тестовую базу (имя содержит «test»)');
  process.exitCode = 2;
} else {
  const pool = createPool(process.env.DATABASE_URL, 2);
  try {
    const http = new TenderHubHttpClient({ baseUrl: process.env.TENDERHUB_URL, apiKey: process.env.TENDERHUB_API_KEY, timeoutMs: 5000, rateLimitPerMinute: 1000, maxResponseBytes: 8 << 20, rateLimitWaits: 0 });
    const captured = await runPortalCapture(new TenderHubApiSource(http), externalTenderId);
    const base = captured.content!;
    const content: ICalcContent = { ...base, header: { ...base.header, kpTotal: base.header.sourceGrandTotal, kpTotalCurrency: 'RUB', kpTotalRule: 'fixture-source-grand-total' } };
    const src = (await primaryCalculationSource(pool, stageId))!;
    const last = (
      await pool.query<{ sha: string; requested_by: string; tender_id: string }>(
        `SELECT c.raw_bundle_sha256 AS sha, c.requested_by, c.tender_id FROM calculation_capture c WHERE c.stage_id = $1 AND c.status = 'complete' ORDER BY c.finished_at DESC LIMIT 1`,
        [stageId],
      )
    ).rows[0]!;
    const cap = await pool.query<{ id: string }>(
      `INSERT INTO calculation_capture (stage_id, tender_id, source_id, system, external_tender_id, capture_kind, transport, trigger, requested_by)
       VALUES ($1, $2, $3, 'tenderhub', $4, 'tenderhub_revision', 'api', 'manual', $5) RETURNING id`,
      [stageId, last.tender_id, src.id, externalTenderId, last.requested_by],
    );
    const r = await withTransaction(pool, (client) =>
      recordSourceRevision(client, {
        captureId: cap.rows[0]!.id,
        externalRevisionRef: 'TH-REV-FIXTURE-UI-15',
        content,
        contentHash: calculationContentHash(content),
        headerLexemes: captured.headerLexemes,
        kpTotalSemantics: { status: 'fixture_rule', note: 'правило итога КП — фикстура проверки этапа 15; Q-05 владельцем не закрыт' },
        rawBundleSha256: last.sha,
        contractVersion: 'x01-contract-fixture',
      }),
    );
    console.log(r.revisionId);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
