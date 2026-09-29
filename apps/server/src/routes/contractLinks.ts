// Связь договора с тендером (D-022 OD-1; portal-api §2.6): многие ко многим, одна строка на пару с
// историей статуса и журналом аудита. Подтверждает человек с contract.link по договору и source.write
// по тендеру: связь лишь предлагает единицы договора кандидатами в состав этапов тендера, область поиска
// она не расширяет ни в одну сторону (D-017, ADR-008 §10). Физического удаления нет — архив (OD-5).
import { ArchiveContractLinkRequest, CreateContractLinkRequest, PatchContractLinkRequest } from '@kontur/contracts';
import { canSeeTenderCard, formatEtag, tenderCapabilities } from '@kontur/core';
import {
  archiveLink,
  confirmLink,
  contractCaps,
  getContract,
  getLink,
  getLinkByPair,
  getStage,
  listContractLinks,
  listTenderLinks,
  memberRoleOf,
  updateLink,
  type IAccessContext,
  type IContractLinkRow,
  type ITenderRow,
  type Pool,
  type Queryable,
} from '@kontur/db';
import { Router } from 'express';
import { toLink } from '../contractMappers.ts';
import { command, parseBody, query, requireIfMatch, uuidParam, versionConflict } from '../http/command.ts';
import { forbidden, HttpError, notFound } from '../http/errors.ts';
import { requireContractCap } from './contractScope.ts';
import { loadContract } from './contracts.ts';
import { loadTender, requireTenderCap } from './tenders.ts';

const view = (ctx: IAccessContext, l: IContractLinkRow) => toLink(l, contractCaps(ctx, l.contract_id));

// События и отказы связи пишутся без tender_id (тендер — в деталях): журнал тендера видят его руководители,
// и участник без выдачи по договору не должен узнать из него о договоре (fail-closed, D-022 OD-2).
const requireSourceWrite = (ctx: IAccessContext, t: ITenderRow, contractId: string): void => {
  if (!tenderCapabilities(ctx.roles, t.member_role).includes('source.write')) {
    throw forbidden('source.write', { entityType: 'contract_tender', details: { contractId, tenderId: t.id } });
  }
};

const canSeeTender = (ctx: IAccessContext, tenderId: string): boolean => canSeeTenderCard(ctx.roles, memberRoleOf(ctx, tenderId));

// Связь видна и меняется, только если видны обе стороны: договор (выдача или admin.contract) и тендер.
// Менять её может пользователь с contract.link по договору и source.write по тендеру.
const loadLinkForChange = async (db: Queryable, ctx: IAccessContext, id: string, lock = false): Promise<IContractLinkRow> => {
  const l = await getLink(db, id, lock);
  if (!l || !(await getContract(db, ctx, l.contract_id)) || !canSeeTender(ctx, l.tender_id)) throw notFound({ entityType: 'contract_tender', entityId: id });
  const target = { entityType: 'contract_tender', entityId: id, details: { contractId: l.contract_id, tenderId: l.tender_id } };
  requireContractCap(ctx, l.contract_id, 'contract.link', target);
  requireSourceWrite(ctx, await loadTender(db, ctx, l.tender_id), l.contract_id);
  return l;
};

const requireStageOfTender = async (db: Queryable, ctx: IAccessContext, stageId: string | null | undefined, tenderId: string): Promise<void> => {
  if (!stageId) return;
  const stage = await getStage(db, ctx, stageId);
  if (!stage || stage.tender_id !== tenderId) throw notFound({ entityType: 'tender_stage', entityId: stageId });
};

export const contractLinksRouter = (pool: Pool): Router => {
  const router = Router();

  router.get(
    '/contracts/:id/tenders',
    query(pool, 'contract.tender.list', 'contract', async (ctx, req, res) => {
      const c = await loadContract(pool, ctx, uuidParam(req, 'id', 'contract'));
      // Тендер без видимой карточки в списке не называется: его существование не раскрывается (A12).
      const items = (await listContractLinks(pool, c.id)).filter((l) => canSeeTender(ctx, l.tender_id));
      res.json({ items: items.map((l) => view(ctx, l)) });
    }),
  );

  router.post(
    '/contracts/:id/tenders',
    command(pool, {
      action: 'contract.tender.link',
      entityType: 'contract_tender',
      idempotent: true,
      authorize: async (client, ctx, req) => {
        const c = await loadContract(client, ctx, uuidParam(req, 'id', 'contract'));
        requireContractCap(ctx, c.id, 'contract.link', { entityType: 'contract', entityId: c.id, details: { contractId: c.id } });
        const body = parseBody(CreateContractLinkRequest, req.body);
        requireSourceWrite(ctx, await loadTender(client, ctx, body.tenderId), c.id);
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'contract');
        const body = parseBody(CreateContractLinkRequest, req.body);
        // Порядок блокировок: договор → тендер; две попытки связать одну пару идут по очереди.
        const c = await loadContract(client, ctx, id, true);
        requireContractCap(ctx, id, 'contract.link', { entityType: 'contract', entityId: id, details: { contractId: id } });
        const t = await loadTender(client, ctx, body.tenderId, true);
        requireSourceWrite(ctx, t, id);
        const target = { entityType: 'contract_tender', details: { contractId: id, tenderId: t.id } };
        if (c.status !== 'active') throw new HttpError(409, 'STATE_CONFLICT', 'договор в архиве: связь не подтверждается', {}, target);
        await requireStageOfTender(client, ctx, body.stageId, t.id);
        const existing = await getLinkByPair(client, id, t.id);
        if (existing?.status === 'active') {
          throw new HttpError(409, 'STATE_CONFLICT', 'связь договора с этим тендером уже подтверждена', { current: view(ctx, existing) }, { ...target, entityId: existing.id });
        }
        const linkId = await confirmLink(client, ctx, { contractId: id, tenderId: t.id, stageId: body.stageId ?? null, note: body.note ?? null, existingId: existing?.id ?? null });
        const after = (await getLink(client, linkId))!;
        const action = existing ? 'contract.tender.restore' : 'contract.tender.link';
        return {
          status: existing ? 200 : 201,
          body: view(ctx, after),
          etag: formatEtag(linkId, after.row_version),
          audit: [{ action, entityType: 'contract_tender', entityId: linkId, details: { contractId: id, tenderId: t.id, stageId: after.stage_id } }],
        };
      },
    }),
  );

  router.patch(
    '/contract-tender-links/:id',
    command(pool, {
      action: 'contract.tender.update',
      entityType: 'contract_tender',
      authorize: async (client, ctx, req) => {
        await loadLinkForChange(client, ctx, uuidParam(req, 'id', 'contract_tender'));
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'contract_tender');
        const l = await loadLinkForChange(client, ctx, id, true);
        if (requireIfMatch(req, id) !== l.row_version) throw versionConflict(view(ctx, l));
        if (l.status !== 'active') throw new HttpError(409, 'STATE_CONFLICT', 'связь в архиве', { current: view(ctx, l) }, { entityId: id });
        const body = parseBody(PatchContractLinkRequest, req.body);
        await requireStageOfTender(client, ctx, body.stageId, l.tender_id);
        await updateLink(client, id, body);
        const after = (await getLink(client, id))!;
        const changes: Record<string, unknown> = {};
        if (after.stage_id !== l.stage_id) changes.stageId = { from: l.stage_id, to: after.stage_id };
        if (after.note !== l.note) changes.note = { from: l.note, to: after.note };
        return {
          status: 200,
          body: view(ctx, after),
          etag: formatEtag(id, after.row_version),
          audit: [{ action: 'contract.tender.update', entityType: 'contract_tender', entityId: id, details: { contractId: l.contract_id, tenderId: l.tender_id, changes } }],
        };
      },
    }),
  );

  // Архив связи не меняет ни владельца редакций договора, ни исторические снимки: снимки ссылаются на
  // пару FK и остаются воспроизводимыми. В рабочий состав этапов единицы договора больше не предлагаются.
  router.post(
    '/contract-tender-links/:id/archive',
    command(pool, {
      action: 'contract.tender.archive',
      entityType: 'contract_tender',
      authorize: async (client, ctx, req) => {
        await loadLinkForChange(client, ctx, uuidParam(req, 'id', 'contract_tender'));
      },
      run: async (client, ctx, req) => {
        const id = uuidParam(req, 'id', 'contract_tender');
        const l = await loadLinkForChange(client, ctx, id, true);
        if (requireIfMatch(req, id) !== l.row_version) throw versionConflict(view(ctx, l));
        if (l.status !== 'active') throw new HttpError(409, 'STATE_CONFLICT', 'связь уже в архиве', { current: view(ctx, l) }, { entityId: id });
        const { reason } = parseBody(ArchiveContractLinkRequest, req.body);
        await archiveLink(client, ctx, id, reason);
        const after = (await getLink(client, id))!;
        return {
          status: 200,
          body: view(ctx, after),
          etag: formatEtag(id, after.row_version),
          audit: [{ action: 'contract.tender.archive', entityType: 'contract_tender', entityId: id, details: { contractId: l.contract_id, tenderId: l.tender_id, reason } }],
        };
      },
    }),
  );

  // Договоры тендера: участник видит только связи с договорами, по которым у него есть выдача;
  // остальные связи не называются и не считаются (fail-closed, D-022 OD-2).
  router.get(
    '/tenders/:id/contracts',
    query(pool, 'tender.contract.list', 'tender', async (ctx, req, res) => {
      const t = await loadTender(pool, ctx, uuidParam(req, 'id', 'tender'));
      requireTenderCap(ctx, t, 'tender.read');
      const items = (await listTenderLinks(pool, t.id)).filter((l) => contractCaps(ctx, l.contract_id).length > 0);
      res.json({ items: items.map((l) => view(ctx, l)) });
    }),
  );

  return router;
};
