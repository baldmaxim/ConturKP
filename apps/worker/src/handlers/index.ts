import type { JobHandler } from '../runtime.ts';
import { calculationCaptureHandler } from './calculation.ts';
import { importExpandHandler, importRegisterHandler } from './imports.ts';
import { intakeScanHandler } from './intake.ts';
import { localRecognitionHandler } from './localRecognition.ts';
import { recognitionImportHandler } from './recognition.ts';
import { indexBuildHandler, indexEmbedHandler, indexPurgeHandler, searchSemanticHandler } from './search.ts';

export const HANDLERS: Record<string, JobHandler> = {
  'import.expand': importExpandHandler,
  'import.register': importRegisterHandler,
  'intake.scan': intakeScanHandler,
  'recognition.import': recognitionImportHandler,
  'recognition.local': localRecognitionHandler,
  'index.build': indexBuildHandler,
  'index.embed': indexEmbedHandler,
  'index.purge': indexPurgeHandler,
  'search.semantic': searchSemanticHandler,
  'calculation.capture': calculationCaptureHandler,
};
