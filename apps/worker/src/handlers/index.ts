import type { JobHandler } from '../runtime.ts';
import { importExpandHandler, importRegisterHandler } from './imports.ts';
import { intakeScanHandler } from './intake.ts';
import { recognitionImportHandler } from './recognition.ts';

export const HANDLERS: Record<string, JobHandler> = {
  'import.expand': importExpandHandler,
  'import.register': importRegisterHandler,
  'intake.scan': intakeScanHandler,
  'recognition.import': recognitionImportHandler,
};
