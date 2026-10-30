import type { IGraphFact } from '../api/factTypes';
import type { IContractDocument } from '../api/contractTypes';
import { formatAmount } from './calculationLabels';

const currencySigns: Record<string, string> = { RUB: '₽', USD: '$', EUR: '€', CNY: '¥', KZT: '₸' };

/** Format the displayed amount only: source quotations and normalized facts stay unchanged. */
export const factValue = (fact: Pick<IGraphFact, 'type' | 'display' | 'normalized'>): string => {
  if (fact.type !== 'contract_price' && fact.type !== 'estimate_total') return fact.display;
  const fallback = /^(-?\d+(?:[.,]\d+)?)\s*(RUB|USD|EUR|CNY|KZT|₽|₸|\$|€|¥)?$/u.exec(fact.display);
  const amount = fact.normalized?.amount ?? fallback?.[1];
  if (amount === undefined || !/^-?\d+(?:[.,]\d+)?$/u.test(String(amount))) return fact.display;
  const currency = String(fact.normalized?.currency ?? fallback?.[2] ?? '');
  return `${formatAmount(String(amount).replace(',', '.'))}${currency ? ` ${currencySigns[currency] ?? currency}` : ''}`;
};

export type DocumentQuality = 'complete' | 'review' | 'unread' | 'pending';
export const documentQuality = (doc: IContractDocument): DocumentQuality => {
  const status = doc.recognition?.status ?? doc.latestRevision.runStatus;
  if (status === 'complete') return 'complete';
  if (status === 'partial') return 'review';
  if (status === 'queued' || status === 'running') return 'pending';
  return 'unread';
};

export const documentCoverage = (doc: IContractDocument): { recognized: number; total: number; percent: number } | null => {
  const total = doc.recognition?.pagesTotal;
  const recognized = doc.recognition?.pagesRecognized;
  if (total == null || total <= 0 || recognized == null || recognized < 0 || recognized > total) return null;
  return { total, recognized, percent: Math.round(100 * recognized / total) };
};
