// Шаги smoke этапа 12 (D-032; ADR-013): комплект-кандидат на настоящих server + worker с LibreOffice. Руководитель
// загружает оригинал и размеченную копию демо-письма (вымышленный текст), ревизия с проверенной разметкой утверждается;
// инженер заполняет приложение и отмечает «заполнено»; тестовый комплект собирается: точный DOCX (SHA-256 из заголовка
// совпадает с байтами), PDF-превью с отметкой «ТЕСТОВЫЙ ВЫПУСК», манифест с content_hash; чтение не пересобирает.
// Вызывается из scripts/smoke.mjs; после перезапуска server комплект проверяется там же.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const octet = { 'Content-Type': 'application/octet-stream' };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const LETTER = {
  letter_date: '2026-10-06',
  letter_number: '04/26-01-ТО',
  addressee: 'Тендерному управлению заказчика (демо)',
  subject: 'Строительство демонстрационного объекта',
  materials_price_date: '2026-09-01',
  advance_percent: '30',
  duration_months: '32',
  validity_days: '30',
};

export const smokeRelease = async ({ root, api, api2, record, waitFor, idem, json, stageId }) => {
  const schema = JSON.parse(readFileSync(join(root, 'docs/forms/demo-kp-letter.forms.json'), 'utf8'));
  const upload = async (file) => {
    const r = await api(`/form-samples?name=${encodeURIComponent(file)}`, { method: 'POST', headers: { ...octet, ...idem() }, body: readFileSync(join(root, 'docs/forms/samples', file)) });
    return r.status === 201 ? (await r.json()).sha256 : null;
  };
  const original = await upload('demo-kp-letter.original.docx');
  const marked = await upload('demo-kp-letter.marked.docx');
  const t = await api('/application-templates', { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ ownerKind: 'company', name: 'Письмо КП (демо, этап 12)', isDemo: true }) });
  const tBody = t.status === 201 ? await t.json() : null;
  const r = tBody
    ? await api(`/application-templates/${tBody.id}/revisions`, {
        method: 'POST',
        headers: { ...json, ...idem() },
        body: JSON.stringify({ schema, sample: { sha256: original, name: 'demo-kp-letter.original.docx' }, markedSample: { sha256: marked, name: 'demo-kp-letter.marked.docx' }, audience: 'customer' }),
      })
    : null;
  const rBody = r?.status === 201 ? await r.json() : null;
  const a = rBody?.markup?.ok ? await api(`/template-revisions/${rBody.id}/approve`, { method: 'POST', headers: { ...json, 'If-Match': r.headers.get('etag') }, body: '{"basisFragmentIds":[]}' }) : null;
  record('этап 12: размеченная копия образца проверена по схеме, ревизия утверждена; оригинал сохранён', a?.status === 200 && rBody?.outputFormat === 'docx' && Boolean(rBody?.sample), `HTTP ${t.status}/${r?.status}/${a?.status}`);

  const d = rBody ? await api2(`/stages/${stageId}/application-drafts`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ templateRevisionId: rBody.id, title: 'Письмо КП' }) }) : null;
  const draft = d?.status === 201 ? await d.json() : null;
  let filled = 0;
  for (const [key, value] of Object.entries(LETTER)) {
    if (!draft) break;
    const view = await (await api2(`/application-drafts/${draft.id}`)).json();
    const field = view.sections.flatMap((s) => s.fields).find((f) => f.key === key);
    const put = await api2(`/application-drafts/${draft.id}/fields/${key}`, { method: 'PUT', headers: { ...json, 'If-Match': field.etag }, body: JSON.stringify({ action: 'set', value, bases: [] }) });
    if (put.status === 200) filled += 1;
  }
  const view = draft ? await (await api2(`/application-drafts/${draft.id}`)).json() : null;
  const done = view ? await api2(`/application-drafts/${draft.id}/complete`, { method: 'POST', headers: { ...json, 'If-Match': view.etag }, body: '{}' }) : null;
  record('этап 12: инженер заполнил приложение и отметил «заполнено»', done?.status === 200 && filled === Object.keys(LETTER).length, `полей: ${filled}, HTTP ${done?.status}`);

  const c = draft ? await api2(`/stages/${stageId}/release-candidates`, { method: 'POST', headers: { ...json, ...idem() }, body: JSON.stringify({ mode: 'test', draftIds: [draft.id] }) }) : null;
  const cBody = c?.status === 201 ? await c.json() : null;
  const ready = cBody
    ? await waitFor(async () => {
        const v = await (await api2(`/release-candidates/${cBody.id}`)).json();
        return v.status !== 'assembling' ? v : null;
      }, 120_000)
    : null;
  record(
    'этап 12: worker собрал тестовый комплект — LibreOffice, проверки пройдены, файл и превью',
    ready?.status === 'ready_for_approval' && /LibreOffice/u.test(ready?.converterVersion ?? '') && ready?.files?.length === 1 && Boolean(ready.files[0].previewFileId),
    ready ? `${ready.status}${ready.failure ? `: ${ready.failure.code} — ${ready.failure.detail}` : ''}` : `HTTP ${c?.status}`,
  );
  const file = ready?.files?.[0];
  const bytes = file ? await api2(`/candidate-files/${file.id}/content`) : null;
  const body = bytes?.status === 200 ? Buffer.from(await bytes.arrayBuffer()) : null;
  const manifest = ready?.contentHash ? await api2(`/release-candidates/${ready.id}/manifest`) : null;
  const mBody = manifest?.status === 200 ? Buffer.from(await manifest.arrayBuffer()) : null;
  record(
    'этап 12: файл отдаётся по ID — те же байты, что в манифесте; content_hash — SHA-256 манифеста',
    Boolean(body) && sha256(body) === file.sha256 && bytes.headers.get('x-content-sha256') === file.sha256 && Boolean(mBody) && sha256(mBody) === ready.contentHash,
  );
  const again = ready ? await (await api2(`/release-candidates/${ready.id}`)).json() : null;
  record('этап 12: чтение комплекта не пересобирает — тот же content_hash', Boolean(again) && again.contentHash === ready.contentHash && again.status === 'ready_for_approval');
  return { candidateId: ready?.id ?? null, contentHash: ready?.contentHash ?? null };
};
