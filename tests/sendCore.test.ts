// Этап 15, ядро: итог сверки вложений с комплектом и хэш комплекта (проект §4); сравнение снимков выпусков — точное
// сопоставление по ID и хэшу содержимого без нечёткого объединения (проект §9–§10). Чистые функции, без БД.
import { describe, expect, it } from 'vitest';
import {
  compareReleaseSnapshots,
  receivedStatus,
  sendCounted,
  sendKitSha256,
  sendStatusOf,
  summarizeSendMatch,
  type IClassifiedAttachment,
  type IKitFile,
  type IReceivedInput,
  type IReleaseSnapshot,
} from '../packages/core/src/index.ts';

const h = (c: string) => c.repeat(64).slice(0, 64);
const kit: IKitFile[] = [
  { path: 'Письмо КП.docx', sha256: h('a'), size: 100 },
  { path: 'Приложение 1.xlsx', sha256: h('b'), size: 200 },
];
const att = (ordinal: number, sha256: string, cls: IClassifiedAttachment['class'], o: Partial<IClassifiedAttachment> = {}): IClassifiedAttachment => ({ ordinal, sha256, size: 1, inline: false, class: cls, kitPath: cls === 'kit' ? 'x' : null, otherReleaseId: cls === 'other_release' ? 'r' : null, ...o });

describe('сверка вложений с комплектом', () => {
  it('«совпало» — каждый файл комплекта присутствует и ничего лишнего; повтор того же файла и другое имя не мешают', () => {
    expect(summarizeSendMatch(kit, [att(1, h('a'), 'kit'), att(2, h('b'), 'kit')])).toMatchObject({ check: 'matched', missing: [], extrasOnly: false });
    expect(summarizeSendMatch(kit, [att(1, h('b'), 'kit'), att(2, h('a'), 'kit'), att(3, h('a'), 'kit')]).check).toBe('matched');
  });

  it('отсутствующий файл, лишнее, внутренний и файл другого выпуска — «не совпало»; «только лишние» — когда комплект цел и лишнее неизвестно', () => {
    expect(summarizeSendMatch(kit, [att(1, h('a'), 'kit')])).toMatchObject({ check: 'mismatched', missing: [kit[1]], extrasOnly: false });
    expect(summarizeSendMatch(kit, [att(1, h('a'), 'kit'), att(2, h('b'), 'kit'), att(3, h('c'), 'unknown', { inline: true })])).toMatchObject({
      check: 'mismatched',
      missing: [],
      extras: { unknown: 1, inline: 1, internal: 0, otherRelease: 0 },
      extrasOnly: true,
    });
    expect(summarizeSendMatch(kit, [att(1, h('a'), 'kit'), att(2, h('b'), 'kit'), att(3, h('d'), 'internal')])).toMatchObject({ check: 'mismatched', extrasOnly: false });
    expect(summarizeSendMatch(kit, [att(1, h('a'), 'kit'), att(2, h('b'), 'kit'), att(3, h('c'), 'unknown'), att(4, h('e'), 'other_release')])).toMatchObject({ extrasOnly: false, extras: { otherRelease: 1 } });
    expect(summarizeSendMatch(kit, [att(1, h('e'), 'other_release'), att(2, h('f'), 'other_release')])).toMatchObject({ check: 'mismatched', extrasOnly: false });
  });

  it('пустой комплект ни с чем не совпадает; письмо без вложений — «не совпало»', () => {
    expect(summarizeSendMatch([], []).check).toBe('mismatched');
    expect(summarizeSendMatch(kit, [])).toMatchObject({ check: 'mismatched', missing: kit, extrasOnly: false });
  });

  it('хэш комплекта не зависит от порядка и меняется от пути, содержимого и размера; статусы', () => {
    const base = sendKitSha256(kit);
    expect(sendKitSha256([...kit].reverse())).toBe(base);
    expect(sendKitSha256([{ ...kit[0]!, path: 'Письмо.docx' }, kit[1]!])).not.toBe(base);
    expect(sendKitSha256([{ ...kit[0]!, sha256: h('c') }, kit[1]!])).not.toBe(base);
    expect(sendKitSha256([{ ...kit[0]!, size: 101 }, kit[1]!])).not.toBe(base);
    expect([sendStatusOf('matched'), sendStatusOf('mismatched'), sendStatusOf('not_checked')]).toEqual(['verified', 'disputed', 'registered']);
    expect([sendCounted('verified'), sendCounted('registered'), sendCounted('disputed')]).toEqual([true, true, false]);
  });
});

const snap = (o: Partial<IReleaseSnapshot> = {}): IReleaseSnapshot => ({
  releaseId: 'L',
  stageId: 'S1',
  manifestSha256: h('1'),
  calculationRevisionId: 'c1',
  sources: [],
  qa: [],
  review: { requirements: [], facts: [], openQuestionIds: [] },
  decisions: [],
  risks: [],
  reviewRisks: [],
  holds: [],
  files: [],
  fields: [],
  ...o,
});
const same = { state: 'same_revision', revisionId: 'c1' } as const;
const changes = (r: ReturnType<typeof compareReleaseSnapshots>, section: string) => r.items.filter((i) => i.section === section).map((i) => `${i.change}:${i.subjectType}`).sort();

describe('сравнение снимков выпусков', () => {
  it('источники: новая редакция, новое распознавание, то же содержимое под другим документом — не «добавлено»', () => {
    const doc = (logicalId: string, revisionId: string, sha: string, run: string | null = 'run') => ({ unitType: 'document_recognition' as const, logicalId, revisionId, sha256: sha, recognitionRunId: run });
    const l = snap({ sources: [doc('d1', 'r1', h('a')), doc('d2', 'r2', h('b'), 'run-old'), doc('d3', 'r3', h('c')), doc('d5', 'r5', h('e'))] });
    const r = snap({ releaseId: 'R', sources: [doc('d1', 'r1x', h('f')), doc('d2', 'r2', h('b'), 'run-new'), doc('d4', 'r4', h('c')), doc('d6', 'r6', h('9'), null), doc('d5', 'r5', h('e'))] });
    const res = compareReleaseSnapshots(l, r, [], same);
    expect(changes(res, 'sources')).toEqual(['added:document_revision', 'recognition_changed:document_revision', 'revision_changed:document_revision', 'same_content:document_revision']);
    expect(res.items.find((i) => i.change === 'added')).toMatchObject({ rightRef: 'r6', detail: { unrecognized: true } });
    expect(res.items.find((i) => i.change === 'same_content')).toMatchObject({ leftRef: 'r3', rightRef: 'r4' });
    expect(res.sections.sources).toMatchObject({ left: 4, right: 5, unchanged: 1 });
  });

  it('требования: тот же ID с тем же содержанием — без строки; другой этап — по хэшу содержания; похожее не объединяется', () => {
    const req = (requirementId: string, revisionId: string, sha: string, cov: string | null = 'covered') => ({ requirementId, revisionId, contentSha256: sha, coverageState: cov });
    const l = snap({ review: { requirements: [req('q1', 'v1', h('a')), req('q2', 'v2', h('b')), req('q3', 'v3', h('c')), req('q4', 'v4', h('d'))], facts: [], openQuestionIds: ['x1', 'x2'] } });
    const r = snap({
      releaseId: 'R',
      review: { requirements: [req('q1', 'v1n', h('a')), req('q2', 'v2n', h('e')), req('z3', 'w3', h('c'), 'partial'), req('z9', 'w9', h('f'))], facts: [], openQuestionIds: ['x2', 'x3'] },
    });
    const res = compareReleaseSnapshots(l, r, [], same);
    expect(changes(res, 'requirements')).toEqual(['added:requirement_revision', 'changed:requirement_revision', 'coverage_changed:requirement_revision', 'removed:requirement_revision']);
    expect(res.items.find((i) => i.change === 'coverage_changed')).toMatchObject({ leftRef: 'v3', rightRef: 'w3', detail: { leftCoverage: 'covered', rightCoverage: 'partial' } });
    expect(res.items.find((i) => i.section === 'requirements' && i.change === 'removed')!.leftRef).toBe('v4');
    expect(res.sections.requirements.unchanged).toBe(1);
    expect(changes(res, 'questions')).toEqual(['closed:customer_question', 'opened:customer_question']);
    // Состояние вопроса — из закреплённого входа («отправлен, ответа нет»), в самом выводе (R15-02).
    expect(res.items.find((i) => i.change === 'opened')).toMatchObject({ rightRef: 'x3', leftRef: null, detail: { rightStatus: 'sent' } });
    expect(res.items.find((i) => i.change === 'closed')).toMatchObject({ leftRef: 'x1', rightRef: null, detail: { leftStatus: 'sent' } });
  });

  it('принятые замечания проверки: серьёзность стороны — из манифеста её выпуска, в самом выводе (R15-02)', () => {
    const l = snap({ reviewRisks: [{ findingId: 'f1', severity: 'major' }, { findingId: 'f2', severity: 'minor' }] });
    const r = snap({ releaseId: 'R', reviewRisks: [{ findingId: 'f2', severity: 'critical' }, { findingId: 'f3', severity: 'critical' }] });
    const res = compareReleaseSnapshots(l, r, [], same);
    expect(changes(res, 'decisions')).toEqual(['added:finding_risk', 'removed:finding_risk']);
    expect(res.items.find((i) => i.change === 'added')).toMatchObject({ rightRef: 'f3', detail: { severity: 'critical' } });
    expect(res.items.find((i) => i.change === 'removed')).toMatchObject({ leftRef: 'f1', detail: { severity: 'major' } });
    expect(res.sections.decisions).toMatchObject({ left: 2, right: 2, unchanged: 1 });
  });

  it('нет закреплённого входа прогона у стороны — раздел «нет данных», а не «нет изменений» (I07)', () => {
    const res = compareReleaseSnapshots(snap({ review: null }), snap({ releaseId: 'R' }), [], same);
    expect(res.sections.requirements).toMatchObject({ unavailable: 'left', changes: {} });
    expect(res.sections.terms).toMatchObject({ unavailable: 'left' });
    expect(res.items.filter((i) => i.section === 'requirements')).toEqual([]);
  });

  it('факты: то же значение — без строки; новое значение в том же пункте — «изменено» только если однозначно; Q&A и решения', () => {
    const fact = (factId: string, key: string, clause: string, status = 'active') => ({ factId, factType: 'advance_percent', normalizedKey: key, documentId: 'doc', clauseRef: clause, conditionSha256: h('0'), status });
    const l = snap({
      review: { requirements: [], facts: [fact('f1', '30', '5.1'), fact('f2', '10', '6.1'), fact('f3', '13', '7.1'), fact('f4', '11', '7.1'), fact('f5', '5', '8.1')], openQuestionIds: [] },
      qa: [{ itemId: 'i1', revisionId: 'a1', contentSha256: h('a'), status: 'open' }, { itemId: 'i2', revisionId: 'a2', contentSha256: h('b'), status: 'open' }],
      decisions: [{ id: 'd1', supersedes: [] }, { id: 'd2', supersedes: [] }],
      holds: [{ eventId: 'e1', decision: 'not_applicable', decisionId: 'h1' }],
    });
    const r = snap({
      releaseId: 'R',
      review: { requirements: [], facts: [fact('g1', '30', '5.1'), fact('g2', '20', '6.1'), fact('g3', '12', '7.1'), fact('g5', '5', '8.1', 'superseded')], openQuestionIds: [] },
      qa: [{ itemId: 'i1', revisionId: 'b1', contentSha256: h('c'), status: 'answered' }, { itemId: 'i3', revisionId: 'b3', contentSha256: h('d'), status: 'open' }],
      decisions: [{ id: 'd1', supersedes: [] }, { id: 'd3', supersedes: ['d2'] }, { id: 'd4', supersedes: [] }],
      holds: [{ eventId: 'e1', decision: 'requires_new_candidate', decisionId: 'h2' }],
    });
    const res = compareReleaseSnapshots(l, r, [], same);
    // 6.1: одно значение слева и одно справа — «изменено»; 7.1: два слева и одно справа — неоднозначно, «снято» и «добавлено».
    expect(changes(res, 'terms')).toEqual(['added:evidence_fact', 'changed:evidence_fact', 'removed:evidence_fact', 'removed:evidence_fact', 'status_changed:evidence_fact']);
    expect(res.items.find((i) => i.section === 'terms' && i.change === 'changed')).toMatchObject({ leftRef: 'f2', rightRef: 'g2' });
    expect(changes(res, 'questions')).toEqual(['added:qa_item_revision', 'answered:qa_item_revision', 'removed:qa_item_revision']);
    expect(changes(res, 'decisions')).toEqual(['added:decision', 'changed:hold_decision', 'superseded:decision']);
    // В ключах и подробностях нет текста значений и условий — только коды, ID и хэши.
    expect(JSON.stringify(res.items)).not.toMatch(/"30"|"20"/u);
  });

  it('файлы и поля: тот же путь с другим содержимым — «изменён», тот же файл под другим путём — «переименован»', () => {
    const l = snap({ files: [{ fileId: 'a', path: 'Письмо.docx', sha256: h('a') }, { fileId: 'b', path: 'Старое имя.xlsx', sha256: h('b') }], fields: [{ templateId: 't', slot: 1, fieldKey: 'subject', versionId: 'v1', valueSha256: h('1') }, { templateId: 't', slot: 1, fieldKey: 'date', versionId: 'v2', valueSha256: h('2') }] });
    const r = snap({ releaseId: 'R', files: [{ fileId: 'c', path: 'Письмо.docx', sha256: h('c') }, { fileId: 'd', path: 'Новое имя.xlsx', sha256: h('b') }], fields: [{ templateId: 't', slot: 1, fieldKey: 'subject', versionId: 'w1', valueSha256: h('3') }, { templateId: 't', slot: 1, fieldKey: 'date', versionId: 'w2', valueSha256: h('2') }] });
    const res = compareReleaseSnapshots(l, r, [], same);
    expect(changes(res, 'applications')).toEqual(['changed:candidate_file', 'changed:field_version', 'renamed:candidate_file']);
    expect(res.sections.applications.unchanged).toBe(1);
  });

  it('хэш результата: детерминирован, не зависит от порядка входа, меняется от содержимого и от сравнения расчёта', () => {
    const doc = (id: string) => ({ unitType: 'document_recognition' as const, logicalId: id, revisionId: `r${id}`, sha256: h(id), recognitionRunId: 'run' });
    const l = snap({ sources: [doc('a'), doc('b')] });
    const r = snap({ releaseId: 'R', sources: [doc('c'), doc('b'), doc('d')] });
    const one = compareReleaseSnapshots(l, r, [], same);
    const two = compareReleaseSnapshots({ ...l, sources: [...l.sources].reverse() }, { ...r, sources: [...r.sources].reverse() }, [], same);
    expect(two.resultSha256).toBe(one.resultSha256);
    expect(two.items).toEqual(one.items);
    expect(compareReleaseSnapshots(l, { ...r, sources: [doc('c'), doc('b')] }, [], same).resultSha256).not.toBe(one.resultSha256);
    expect(compareReleaseSnapshots(l, r, [], { state: 'compared', comparisonId: 'x', resultSha256: h('9') }).resultSha256).not.toBe(one.resultSha256);
    // ID сравнения расчёта в хэш не входит — только его результат.
    expect(compareReleaseSnapshots(l, r, [], { state: 'compared', comparisonId: 'y', resultSha256: h('9') }).resultSha256).toBe(compareReleaseSnapshots(l, r, [], { state: 'compared', comparisonId: 'x', resultSha256: h('9') }).resultSha256);
  });
});

describe('получено между выпусками', () => {
  const base: IReceivedInput = { kind: 'document_revision', id: 'r', revisionId: 'r', sha256: null, inInterval: true, repeatOccurrence: false, inRightScope: true, rightRecognized: true, recognizedAfterLeft: false, disposition: 'none', decisionId: null };
  it('в области, вне области, без распознавания, поздно распознано, то же содержимое под новым именем', () => {
    expect(receivedStatus(base)).toBe('in_scope');
    expect(receivedStatus({ ...base, inRightScope: false, rightRecognized: false })).toBe('out_of_scope');
    expect(receivedStatus({ ...base, rightRecognized: false })).toBe('not_recognized');
    expect(receivedStatus({ ...base, inInterval: false, recognizedAfterLeft: true })).toBe('late_recognized');
    // Получено и распознано до левого выпуска — к интервалу не относится.
    expect(receivedStatus({ ...base, inInterval: false })).toBeNull();
    expect(receivedStatus({ ...base, kind: 'document_occurrence', repeatOccurrence: true })).toBe('same_content_new_name');
    expect(receivedStatus({ ...base, kind: 'document_occurrence' })).toBeNull();
    expect(receivedStatus({ ...base, kind: 'mail_message', inRightScope: false })).toBe('out_of_scope');
  });

  it('письмо вне снимка несёт закреплённую ревизию и её хэш; другая ревизия — другой результат (R15-03)', () => {
    const mail = (revisionId: string, sha: string): IReceivedInput => ({ ...base, kind: 'mail_message', id: 'm1', revisionId, sha256: sha, inRightScope: false, rightRecognized: false });
    const one = compareReleaseSnapshots(snap(), snap({ releaseId: 'R' }), [mail('v1', h('a'))], same);
    expect(one.items[0]).toMatchObject({ section: 'received', change: 'out_of_scope', subjectType: 'mail_message', leftRef: null, rightRef: 'v1', rightSha256: h('a'), detail: { subjectId: 'm1' } });
    const other = compareReleaseSnapshots(snap(), snap({ releaseId: 'R' }), [mail('v2', h('b'))], same);
    expect(other.resultSha256).not.toBe(one.resultSha256);
  });

  it('файл вне области попадает только в блок «получено» и не меняет разделы', () => {
    const res = compareReleaseSnapshots(snap(), snap({ releaseId: 'R' }), [{ ...base, inRightScope: false, rightRecognized: false, disposition: 'not_applicable', decisionId: 'd' }], same);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ section: 'received', change: 'out_of_scope', detail: { disposition: 'not_applicable', decisionId: 'd' } });
    expect(res.sections.sources.changes).toEqual({});
  });
});
