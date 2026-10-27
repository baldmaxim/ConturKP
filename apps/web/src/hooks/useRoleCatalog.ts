import { listPortalRoles } from '../api/roleEndpoints';
import { useApiResource } from './useApiResource';
export const useRoleCatalog = (selected: string[] = []) => {
 const resource = useApiResource(signal=>listPortalRoles(signal),'assignable-role-catalog');
 const options=(resource.data?.items??[]).filter(r=>r.status==='active'||selected.includes(r.code)).map(r=>({value:r.code,label:r.name+(r.status==='disabled'?' (отключена)':'')}));
 return {...resource,options};
};
