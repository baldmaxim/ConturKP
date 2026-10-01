// Провайдер генеративной модели из настройки (OD-08-2). Сервер создаёт его только ради описания модели
// (провайдер, модель, версия, настройки — ключ повтора прогона) и в модель не ходит (ADR-007); вызывает её worker.
import { FakeChat } from './fake.ts';
import { OpenAiCompatibleChat } from './openaiCompatible.ts';
import type { IModelGatewayChat } from './types.ts';

export interface IChatModelSettings {
  provider: 'none' | 'openai_compatible' | 'fake';
  baseUrl: string | null;
  model: string | null;
  revision: string;
  apiKey: string | null;
  timeoutMs: number;
  maxInputChars: number;
  maxOutputTokens: number;
  jsonMode: 'none' | 'json_object';
}

export const createChatModel = (c: IChatModelSettings): IModelGatewayChat | null => {
  if (c.provider === 'openai_compatible' && c.baseUrl && c.model) {
    return new OpenAiCompatibleChat({
      baseUrl: c.baseUrl,
      model: c.model,
      revision: c.revision,
      apiKey: c.apiKey,
      timeoutMs: c.timeoutMs,
      maxInputChars: c.maxInputChars,
      maxOutputTokens: c.maxOutputTokens,
      jsonMode: c.jsonMode,
    });
  }
  if (c.provider === 'fake') return new FakeChat({ model: c.model ?? 'fake-chat', revision: c.revision, maxInputChars: c.maxInputChars });
  return null;
};
