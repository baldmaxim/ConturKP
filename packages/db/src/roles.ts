import type { Role } from '@kontur/core';
import type { Queryable } from './pool.ts';
export interface IPortalRoleRow {
 id:string;code:string;name:string;description:string;base_role:Role;permissions:string[];built_in:boolean;status:'active'|'disabled';row_version:number;users_count:number;
}
const SELECT_ROLE='SELECT p.*, (SELECT count(*)::int FROM user_role ur WHERE ur.role=p.code) AS users_count FROM portal_role p';
export const listPortalRoles=async(db:Queryable):Promise<IPortalRoleRow[]> => (await db.query<IPortalRoleRow>(SELECT_ROLE+' ORDER BY p.built_in DESC,p.created_at,p.id')).rows;
export const getPortalRole=async(db:Queryable,id:string,lock=false):Promise<IPortalRoleRow|null> => (await db.query<IPortalRoleRow>(SELECT_ROLE+' WHERE p.id=$1'+(lock?' FOR UPDATE OF p':''),[id])).rows[0]??null;
export const activeRoleCodes=async(db:Queryable,codes:string[]):Promise<string[]> => (await db.query<{code:string}>("SELECT code FROM portal_role WHERE code=ANY($1::text[]) AND status='active'",[codes])).rows.map(r=>r.code);
export const insertPortalRole=async(db:Queryable,r:{id:string;name:string;description:string;baseRole:Role;permissions:string[]}):Promise<void> => {
 await db.query('INSERT INTO portal_role(id,code,name,description,base_role,permissions) VALUES($1,$2,$3,$4,$5,$6)',[r.id,'role_'+r.id,r.name,r.description,r.baseRole,r.permissions]);
};
export const updatePortalRole=async(db:Queryable,id:string,r:{name:string;description:string;baseRole:Role;permissions:string[];status:'active'|'disabled'}):Promise<void> => {
 await db.query('UPDATE portal_role SET name=$2,description=$3,base_role=$4,permissions=$5,status=$6,row_version=row_version+1,updated_at=now() WHERE id=$1',[id,r.name,r.description,r.baseRole,r.permissions,r.status]);
};
