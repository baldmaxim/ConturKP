import { apiGet,apiPost,apiPatch } from './client';
export interface IPortalRole {id:string;code:string;name:string;description:string;baseRole:'engineer'|'manager'|'admin';permissions:string[];builtIn:boolean;status:'active'|'disabled';rowVersion:number;users:number}
export interface IRoleCatalog {items:IPortalRole[];permissions:{code:string;label:string;group:string}[]}
export interface IRoleInput {name:string;description:string;baseRole:IPortalRole['baseRole'];permissions:string[]}
export const listPortalRoles=(signal?:AbortSignal):Promise<IRoleCatalog>=>apiGet('/admin/roles',{signal});
export const createPortalRole=(input:IRoleInput,key:string):Promise<IPortalRole>=>apiPost('/admin/roles',{body:input,idempotencyKey:key});
export const updatePortalRole=(role:IPortalRole,input:IRoleInput&{status:IPortalRole['status']}):Promise<IPortalRole>=>apiPatch('/admin/roles/'+encodeURIComponent(role.id),{body:input,ifMatch:'"'+role.id+':'+role.rowVersion+'"'});
