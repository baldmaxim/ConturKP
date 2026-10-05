import type { JobHandler } from '../runtime.ts';
import { analysisExtractHandler } from './analysis.ts';
import { analysisRulesHandler } from './analysisRules.ts';
import { answerGenerateHandler } from './answer.ts';
import { calculationCaptureHandler } from './calculation.ts';
import { economicsReasonsHandler } from './economics.ts';
import { factExtractHandler } from './facts.ts';
import { importExpandHandler, importRegisterHandler } from './imports.ts';
import { intakeScanHandler } from './intake.ts';
import { localRecognitionHandler } from './localRecognition.ts';
import { mailImportHandler } from './mail.ts';
import { recognitionImportHandler } from './recognition.ts';
import { reviewModelHandler, reviewRunHandler, stageInvalidateHandler } from './review.ts';
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
  'mail.import': mailImportHandler,
  'analysis.extract': analysisExtractHandler,
  'analysis.rules': analysisRulesHandler,
  'answer.generate': answerGenerateHandler,
  'fact.extract': factExtractHandler,
  'review.run': reviewRunHandler,
  'review.model': reviewModelHandler,
  'stage.invalidate': stageInvalidateHandler,
  'economics.reasons': economicsReasonsHandler,
};
