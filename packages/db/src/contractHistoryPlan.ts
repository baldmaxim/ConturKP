import {CREATOR_CAPABILITIES} from '@kontur/core';
import {loadAccessContext,canCreateContract} from './access.ts';
import {insertContract,isContractAdmin,insertGrant} from './contracts.ts';
import {auditFor,writeAudit} from './audit.ts';
import {importContractHistory,type IContractHistoryInput} from './contractHistory.ts';
import type {Queryable} from './pool.ts';

export interface IContractHistoryPlan {
 version:1;
 cards:{key:string;number:string;title:string;counterparty:string|null;signedOn:null;bindings:IContractHistoryInput[]}[];
}

// Caller owns the transaction. Dry runs must force deferred constraints before rollback.
export const importContractHistoryPlan=async(db:Queryable,actor:string,plan:IContractHistoryPlan,grantCreator=false)=>{
 if(plan.version!==1||!Array.isArray(plan.cards)||!plan.cards.length||plan.cards.length>1000)throw Error('history_invalid_plan');
 let ctx=await loadAccessContext(db,actor,'contract-history-import');
 if(!ctx||!isContractAdmin(ctx))throw Error('history_import_requires_contract_admin');
 if(!canCreateContract(ctx)&&grantCreator){
  if(!ctx.roles.has('manager')&&!ctx.roles.has('engineer'))throw Error('history_import_requires_content_role');
  await insertGrant(db,ctx,{contractId:null,userId:actor,capability:'contract.create'});
  await writeAudit(db,auditFor(ctx,{action:'contract.creator.grant',entityType:'app_user',entityId:actor,outcome:'allowed',details:{capability:'contract.create',reason:'contract-history-import'}}));
  ctx=(await loadAccessContext(db,actor,'contract-history-import'))!;
 }
 if(!canCreateContract(ctx))throw Error('history_import_requires_creator_grant');
 await db.query("SELECT pg_advisory_xact_lock(hashtext('contract-history-plan'))");
 const result={created:0,importsAdded:0,filesAdded:0,repeated:0,contracts:[] as {key:string;id:string}[]};
 const seen=new Set<string>();
 for(const c of plan.cards){
  if(!c.key||seen.has(c.key)||!c.number?.trim()||!c.title?.trim()||!c.bindings?.length||c.signedOn!==null)throw Error('history_invalid_card');
  seen.add(c.key);
  const first=c.bindings[0]!;
  const existing=(await db.query<{id:string}>('SELECT DISTINCT contract_id AS id FROM contract_history_binding WHERE source_key=$1 AND group_key=$2',[first.sourceKey,first.groupKey])).rows;
  if(existing.length>1)throw Error('history_ambiguous_existing_card');
  let id=existing[0]?.id;
  if(!id){
   id=await insertContract(db,ctx,{number:c.number,title:c.title,counterparty:c.counterparty,signedOn:null},CREATOR_CAPABILITIES);result.created++;
   await writeAudit(db,auditFor(ctx,{action:'contract.create',entityType:'contract',entityId:id,outcome:'allowed',details:{source:'contract-history-import',creatorCapabilities:[...CREATOR_CAPABILITIES]}}));
  }
  ctx=(await loadAccessContext(db,actor,'contract-history-import'))!;
  for(const binding of c.bindings){
   const added=await importContractHistory(db,ctx,id,binding);
   if(added.repeated)result.repeated++;else{
    result.importsAdded++;result.filesAdded+=added.filesAdded;
    await writeAudit(db,auditFor(ctx,{action:'contract.history.import',entityType:'contract',entityId:id,outcome:'allowed',details:{bindingId:added.bindingId,importId:added.importId,files:added.filesAdded,sourceSha256:binding.sourceSha256,observedAt:binding.observedAt}}));
   }
  }
  result.contracts.push({key:c.key,id});
 }
 await db.query('SET CONSTRAINTS ALL IMMEDIATE');
 return result;
};
