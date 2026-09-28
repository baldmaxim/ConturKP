// Провайдер эмбеддингов из конфигурации (ADR-012 §25). Создаётся только в worker: сервер во
// внешние системы не ходит (ADR-007), а вектор запроса берёт из кеша или ставит задание.
import { FakeEmbeddings, OpenAiCompatibleEmbeddings, type IModelGatewayEmbeddings } from '@kontur/adapters';
import type { IEmbeddingConfig } from '@kontur/config';

export const createEmbeddings = (c: IEmbeddingConfig): IModelGatewayEmbeddings | null => {
  if (c.provider === 'openai_compatible') {
    return new OpenAiCompatibleEmbeddings({
      baseUrl: c.baseUrl!,
      model: c.model!,
      revision: c.revision,
      apiKey: c.apiKey,
      timeoutMs: c.timeoutMs,
      batchSize: c.batchSize,
      expectedDim: c.dim,
    });
  }
  if (c.provider === 'fake') return new FakeEmbeddings({ dim: c.dim ?? 64, batchSize: c.batchSize });
  return null;
};
