import { useContext } from 'react';
import { OfficeContext, type IOfficeResource } from './officeContext';

export const useOffice = (): IOfficeResource => useContext(OfficeContext);
