import type { FC } from 'react';
import { Navigate } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { useAuth } from '../hooks/useAuth';
import { TendersPage } from '../pages/TendersPage';
export const HomePage:FC=()=>{
 const {me,can}=useAuth();
 if(me?.tendersAvailable!==false)return <TendersPage/>;
 const target=can('office.read')?'/office':me.contractsAvailable?'/contracts':me.mailAvailable?'/mail':can('templates.read')?'/forms':can('history.read')?'/history':['admin.users','admin.roles','admin.audit','admin.contract','admin.delivery'].some(can)?'/admin':null;
 return target?<Navigate to={target} replace/>:<EmptyState icon="shield-x" title="Нет доступных разделов" text="Администратор может назначить вам роль или изменить её разрешения."/>;
};
