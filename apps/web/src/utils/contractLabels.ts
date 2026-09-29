// Подписи договорного контура (этап 06a).
import type { TContractCapability, TContractRole } from '../api/contractTypes';

export const CONTRACT_ROLE_LABELS: Record<TContractRole, string> = {
  contract: 'Основной договор',
  addendum: 'Допсоглашение',
  appendix: 'Приложение',
};

export const CONTRACT_CAPABILITY_LABELS: Record<TContractCapability, string> = {
  'contract.read': 'Чтение содержимого',
  'contract.link': 'Связь с тендерами',
  'contract.manage': 'Ведение: документы, карточка, архив',
};

export const CONTRACT_CAPABILITY_HINTS: Record<TContractCapability, string> = {
  'contract.read': 'Документы, текст, поиск и цитаты договора.',
  'contract.link': 'Подтверждение и архив связи с тендером, где пользователь ведёт источники.',
  'contract.manage': 'Загрузка документов и редакций, правка карточки, архив. Содержимое — только вместе с чтением.',
};

export const ALL_CONTRACT_CAPABILITIES: TContractCapability[] = ['contract.read', 'contract.link', 'contract.manage'];
