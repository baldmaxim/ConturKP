// Проверка возможности по договору (D-022 OD-2): выдача строкой contract_access и роль инженера
// или руководителя. Договор вне видимости пользователя — 404, видимый без нужной возможности — 403.
import type { ContractCapability } from '@kontur/core';
import { contractCaps, type IAccessContext, type IRevisionRow } from '@kontur/db';
import { forbidden, type IAuditTarget } from '../http/errors.ts';
import { requireTenderCapById } from './scope.ts';

export const hasContractCap = (ctx: IAccessContext, contractId: string, cap: ContractCapability): boolean => contractCaps(ctx, contractId).includes(cap);

export const requireContractCap = (ctx: IAccessContext, contractId: string, cap: ContractCapability, target: IAuditTarget): void => {
  if (!hasContractCap(ctx, contractId, cap)) throw forbidden(cap, { ...target, details: { ...target.details, contractId } });
};

// Изменение редакции (импорт распознавания): у тендера — source.write, у договора — contract.manage
// (чтение редакции договора уже проверено её выборкой getRevision).
export const requireRevisionWrite = (ctx: IAccessContext, rev: IRevisionRow, target: IAuditTarget): void => {
  if (rev.tender_id) requireTenderCapById(ctx, rev.tender_id, 'source.write', target);
  else requireContractCap(ctx, rev.contract_id!, 'contract.manage', target);
};
