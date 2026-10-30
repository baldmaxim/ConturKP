import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { CreateRoleRequest, PatchRoleRequest } from '@kontur/contracts';
import { formatEtag,globalCapabilities,normalizeRolePermissions,ROLE_PERMISSION_CATALOG } from '@kontur/core';
import { activeRoleCodes,countActiveAdmins,getPortalRole,insertPortalRole,listPortalRoles,loadAccessContext,lockAdminSet,updatePortalRole,type IAccessContext,type IPortalRoleRow,type Pool,type Queryable } from '@kontur/db';
import { command,parseBody,query,requireIfMatch,uuidParam,versionConflict } from '../http/command.ts';
import { forbidden,HttpError,notFound } from '../http/errors.ts';
export const toPortalRole=(r:IPortalRoleRow)=>({id:r.id,code:r.code,name:r.name,description:r.description,baseRole:r.base_role,permissions:r.permissions,builtIn:r.built_in,status:r.status,rowVersion:r.row_version,users:r.users_count});
const requireManage=(ctx:IAccessContext):void=>{if(!globalCapabilities(ctx.roles).includes('admin.roles'))throw forbidden('admin.roles',{entityType:'portal_role'});};
const load=async(db:Queryable,id:string,lock=false)=>{const r=await getPortalRole(db,id,lock);if(!r)throw notFound({entityType:'portal_role',entityId:id});return r;};
const lockAndAuthorize=async(db:Queryable,ctx:IAccessContext)=>{await lockAdminSet(db);const fresh=await loadAccessContext(db,ctx.principal.userId,ctx.requestId);if(!fresh)throw forbidden('admin.roles',{entityType:'portal_role'});requireManage(fresh);};
export const validateAssignedRoles=async(db:Queryable,codes:string[])=>{
 if((await activeRoleCodes(db,codes)).length!==new Set(codes).size)throw new HttpError(409,'STATE_CONFLICT','Одна из выбранных ролей отсутствует или отключена');
};
export const rolesRouter=(pool:Pool):Router=>{
 const router=Router();
 router.get('/admin/roles',query(pool,'admin.roles.list','portal_role',async(ctx,_req,res)=>{
   const caps=globalCapabilities(ctx.roles);if(!caps.includes('admin.roles')&&!caps.includes('admin.users'))throw forbidden('admin.roles',{entityType:'portal_role'});
   res.json({items:(await listPortalRoles(pool)).map(toPortalRole),permissions:ROLE_PERMISSION_CATALOG});
 }));
 router.post('/admin/roles',command(pool,{action:'admin.role.create',entityType:'portal_role',idempotent:true,authorize:async(_db,ctx)=>requireManage(ctx),run:async(db,ctx,req)=>{
   await lockAndAuthorize(db,ctx);const body=parseBody(CreateRoleRequest,req.body);const id=randomUUID();
   await insertPortalRole(db,{...body,id,permissions:normalizeRolePermissions(body.permissions)});
   const r=toPortalRole(await load(db,id));return{status:201,body:r,etag:formatEtag(id,r.rowVersion),audit:[{action:'admin.role.create',entityType:'portal_role',entityId:id,details:{name:r.name,baseRole:r.baseRole,permissions:r.permissions}}]};
 }}));
 router.patch('/admin/roles/:id',command(pool,{action:'admin.role.update',entityType:'portal_role',authorize:async(_db,ctx)=>requireManage(ctx),run:async(db,ctx,req)=>{
   await lockAndAuthorize(db,ctx);const id=uuidParam(req,'id','portal_role');const before=await load(db,id,true);
   if(requireIfMatch(req,id)!==before.row_version)throw versionConflict(toPortalRole(before));
   const body=parseBody(PatchRoleRequest,req.body);
   if(before.built_in && before.base_role!==body.baseRole)throw new HttpError(409,'STATE_CONFLICT','Основа системной роли не меняется. Создайте собственную роль.');
   await updatePortalRole(db,id,{...body,permissions:normalizeRolePermissions(body.permissions)});
   if(await countActiveAdmins(db)===0)throw new HttpError(409,'STATE_CONFLICT','Нельзя оставить портал без активного администратора, который управляет пользователями и ролями.');
   const r=toPortalRole(await load(db,id));return{status:200,body:r,etag:formatEtag(id,r.rowVersion),audit:[{action:'admin.role.update',entityType:'portal_role',entityId:id,details:{from:toPortalRole(before),to:r}}]};
 }}));
 return router;
};
