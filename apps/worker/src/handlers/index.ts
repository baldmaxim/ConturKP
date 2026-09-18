import type { JobHandler } from '../runtime.ts';
import { handleImportExpand, handleImportRegister } from './imports.ts';
import { handleIntakeScan } from './intake.ts';

export const HANDLERS: Record<string, JobHandler> = {
  'import.expand': handleImportExpand,
  'import.register': handleImportRegister,
  'intake.scan': handleIntakeScan,
};
