// Пилот (этап 18, проект §5.1) — оценка кандидата на пилот и его текстовый вывод. Чистая логика без БД и сети.

export interface ICandidateData {
  tenderId: string;
  // Отправки по статусу send_event (0039).
  sends: Record<string, number>;
  // Документы тендера с хотя бы одной редакцией — по виду (document.doc_type) с числом документов, у которых ≥ 2 редакций.
  documentsByType: { docType: string; documents: number; multiRevision: number }[];
  linkedContracts: number;
  linkedMailMessages: number;
  qaThreads: number;
  negotiationSessions: number;
  calculationRevisions: { provisional: number; verified: number };
  stages: { id: string; seq: number; status: string }[];
}
export interface ICandidateResult {
  verdict: 'SUITABLE' | 'INCOMPLETE';
  missing: string[];
  notes: string[];
  data: ICandidateData & { sendsCounted: number; documentsWithManyRevisions: number };
}

// Засчитанная отправка — registered или verified; disputed (состав вложений не совпал) отправкой утверждённого
// комплекта не считается (0039, A32). Виды документов задаёт человек (doc_type по умолчанию other): список видов в
// отчёте для проверки глазами.
export const evaluateCandidate = (d: ICandidateData): ICandidateResult => {
  const sendsCounted = (d.sends.registered ?? 0) + (d.sends.verified ?? 0);
  const documentsWithManyRevisions = d.documentsByType.reduce((n, t) => n + t.multiRevision, 0);
  const docsOf = (type: string): number => d.documentsByType.find((t) => t.docType === type)?.documents ?? 0;
  const missing: string[] = [];
  if (sendsCounted < 2) missing.push(`отправок КП меньше двух (засчитано ${sendsCounted})`);
  if (docsOf('contract') + d.linkedContracts === 0) missing.push('нет договора (ни документа вида contract, ни связанного договора)');
  if (docsOf('tz') === 0) missing.push('нет документа вида tz (ТЗ)');
  if (documentsWithManyRevisions === 0) missing.push('нет документа с двумя и более редакциями');
  const notes = [
    'вид документа (doc_type) задаёт человек, по умолчанию other: сверьте список видов с фактическим составом',
    'названия и номер тендера в отчёт не попадают',
  ];
  if (d.calculationRevisions.provisional + d.calculationRevisions.verified === 0) notes.push('ревизий расчёта TenderHub нет');
  return { verdict: missing.length === 0 ? 'SUITABLE' : 'INCOMPLETE', missing, notes, data: { ...d, sendsCounted, documentsWithManyRevisions } };
};

export const renderCandidate = (r: ICandidateResult): string => {
  const d = r.data;
  const lines = [
    `Тендер портала: ${d.tenderId}`,
    `Итог: ${r.verdict}`,
    ...(r.missing.length > 0 ? ['Недостаёт:', ...r.missing.map((m) => `  - ${m}`)] : []),
    `Отправки КП: ${Object.entries(d.sends).map(([s, n]) => `${s} ${n}`).join(', ') || 'нет'}; засчитано ${d.sendsCounted}`,
    'Виды источников (документов с редакциями; с ≥ 2 редакциями):',
    ...(d.documentsByType.length > 0 ? d.documentsByType.map((t) => `  - ${t.docType}: ${t.documents}; ${t.multiRevision}`) : ['  - документов нет']),
    `Связанные договоры: ${d.linkedContracts}; письма: ${d.linkedMailMessages}; ветки вопросов-ответов: ${d.qaThreads}; сессии переговоров: ${d.negotiationSessions}`,
    `Документов с ≥ 2 редакциями: ${d.documentsWithManyRevisions}`,
    `Ревизии расчёта TenderHub: provisional ${d.calculationRevisions.provisional}, verified ${d.calculationRevisions.verified}`,
    `Этапы: ${d.stages.map((s) => `№${s.seq} ${s.status} (${s.id})`).join('; ') || 'нет'}`,
    ...r.notes.map((n) => `Примечание: ${n}`),
  ];
  return lines.join('\n');
};
