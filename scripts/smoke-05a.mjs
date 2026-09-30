// Шаги smoke этапа 05a (D-024): локальное распознавание на реальных server + worker — OCR tesseract.js
// внутри worker, без сети. DOCX договора распознаётся автоматически; PDF-скан с политикой auto —
// только явной командой. Вызывается из scripts/smoke.mjs после шагов этапа 06a.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractDocx, uniqueCopy } from '../tests/localFixtures.ts';

export const smokeLocalRecognition = async ({ root, api, search, record, waitFor, sleep, idem, octet, json, contractId, mainDocumentId, stageId }) => {
  const cdocx = await api(`/contracts/${contractId}/documents?name=${encodeURIComponent('Договор-smoke.docx')}&role=appendix&mainDocumentId=${mainDocumentId}`, {
    method: 'POST',
    headers: { ...octet, ...idem() },
    body: uniqueCopy(contractDocx(), 'zip'),
  });
  const cdocxBody = await cdocx.json();
  const docxRun = await waitFor(async () => {
    const r = await (await api(`/document-revisions/${cdocxBody.revisionId}/recognition-runs`)).json();
    return r.items?.[0]?.status === 'complete' ? r.items[0] : null;
  }, 60_000);
  record(
    'этап 05a: DOCX договора распознан локально автоматически (worker)',
    cdocx.status === 201 && docxRun?.engine === 'local_ocr' && docxRun.trigger === 'auto' && docxRun.preferred === true,
    docxRun ? `движок ${docxRun.engine}, итог ${docxRun.outcome}` : 'нет результата',
  );
  const docxHit = await waitFor(async () => {
    const r = await search({ context: { kind: 'contract', contractId }, query: 'цена договора 245 000 000', limit: 5 });
    if (r.status !== 200) return null;
    const b = await r.json();
    return (b.fused?.items ?? []).find((h) => h.engine === 'local_ocr') ?? null;
  }, 60_000);
  record(
    'этап 05a: поиск договора находит локальный фрагмент с якорем, движком и итогом, без координат',
    Boolean(docxHit) && docxHit.locator?.kind === 'docx_paragraph' && docxHit.runOutcome === 'complete' && docxHit.text.includes('245 000 000'),
    docxHit ? JSON.stringify(docxHit.locator) : 'нет результата',
  );
  const scanBytes = uniqueCopy(readFileSync(join(root, 'tests', 'fixtures', 'local', 'letter-scan.pdf')), 'pdf');
  const upScan = await api(`/stages/${stageId}/imports?name=${encodeURIComponent('Письмо-скан-smoke.pdf')}`, { method: 'POST', headers: { ...octet, ...idem() }, body: scanBytes });
  const scanBatch = await upScan.json();
  const scanDone = await waitFor(async () => {
    const b = await (await api(`/imports/${scanBatch.id}`)).json();
    return b.status === 'completed' ? b : null;
  }, 30_000);
  const scanRev = scanDone?.items?.[0]?.documentRevisionId;
  // Несколько проходов обслуживания worker: PDF с политикой auto сам не распознаётся (OD-1).
  await sleep(12_000);
  const scanIdle = await (await api(`/document-revisions/${scanRev}/recognition-runs`)).json();
  record('этап 05a: PDF с политикой auto автоматически не распознаётся', Array.isArray(scanIdle.items) && scanIdle.items.length === 0);
  const cmd = await api(`/document-revisions/${scanRev}/local-recognitions`, { method: 'POST', headers: { ...json, ...idem() }, body: '{}' });
  const cmdBody = await cmd.json();
  const scanRun = await waitFor(async () => {
    const r = await (await api(`/recognition-runs/${cmdBody.run?.id}`)).json();
    return r.status === 'complete' || r.status === 'partial' || r.status === 'failed' ? r : null;
  }, 120_000);
  const scanFrags = scanRun ? await (await api(`/recognition-runs/${scanRun.id}/fragments`)).json() : { items: [] };
  record(
    'этап 05a: скан PDF распознан OCR по явной команде — распознанный текст, итог complete',
    cmd.status === 202 && scanRun?.status === 'complete' && scanRun.recognizer?.processing === 'native_text+ocr' &&
      scanFrags.items?.some((f) => f.origin === 'recognized_text' && f.locator?.method === 'ocr' && f.text.includes('Стромынка')),
    scanRun ? `итог ${scanRun.outcome}, уверенность ${scanRun.quality?.units?.[0]?.metrics?.ocrConfidence ?? '—'}` : 'нет результата',
  );
};
