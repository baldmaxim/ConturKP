// Проверка возможности по договору (D-022 OD-2): выдача строкой contract_access и роль инженера
// или руководителя. Договор вне видимости пользователя — 404, видимый без нужной возможности — 403.
import type { ContractCapability, MailCapability } from '@kontur/core';
import { contractCaps, mailCaps, type IAccessContext, type IRevisionRow } from '@kontur/db';
import { forbidden, type IAuditTarget } from '../http/errors.ts';
import { requireTenderCapById } from './scope.ts';

export const hasContractCap = (ctx: IAccessContext, contractId: string, cap: ContractCapability): boolean => contractCaps(ctx, contractId).includes(cap);

export const requireContractCap = (ctx: IAccessContext, contractId: string, cap: ContractCapability, target: IAuditTarget): void => {
  if (!hasContractCap(ctx, contractId, cap)) throw forbidden(cap, { ...target, details: { ...target.details, contractId } });
};

export const requireMailCap = (ctx: IAccessContext, mailboxId: string, cap: MailCapability, target: IAuditTarget): void => {
  if (!mailCaps(ctx, mailboxId).includes(cap)) throw forbidden(cap, { ...target, details: { ...target.details, mailboxId } });
};

// Изменение редакции (импорт распознавания, команда локального распознавания): у тендера — source.write,
// у договора — contract.manage, у вложения письма — mail.import на ящик письма (D-025). Чтение редакции
// уже проверено её выборкой getRevision.
export const requireRevisionWrite = (ctx: IAccessContext, rev: IRevisionRow, target: IAuditTarget): void => {
  if (rev.tender_id) requireTenderCapById(ctx, rev.tender_id, 'source.write', target);
  else if (rev.contract_id) requireContractCap(ctx, rev.contract_id, 'contract.manage', target);
  else requireMailCap(ctx, rev.mailbox_id!, 'mail.import', target);
};
