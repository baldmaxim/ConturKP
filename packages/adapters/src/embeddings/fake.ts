// Детерминированный поддельный провайдер (ADR-012 §20): вектор — хэш-мешок слов, поэтому
// тексты с общими словами ближе друг к другу, а один и тот же текст всегда даёт один вектор.
// Проверяет конвейер, фильтр области и жизненный цикл прогона без GPU. Рабочей моделью не
// является: в production конфигурация его не допускает, а версия индекса несёт его имя.
import { createHash } from 'node:crypto';
import { MAX_EMBEDDING_DIM, PROBE_TEXT } from '@kontur/core';
import { embeddingError, validateVectors, type EmbeddingResult, type IEmbedOutput, type IModelGatewayEmbeddings, type IModelProbe } from './types.ts';

export interface IFakeEmbeddingsOptions {
  dim?: number;
  model?: string;
  revision?: string;
  batchSize?: number;
}

// Управляемые отказы для тестов деградации: модель недоступна, неверная размерность, задержка.
export interface IFakeBehaviour {
  unavailable: boolean;
  wrongDim: number | null;
  delayMs: number;
  // Смещение векторов: имитирует подмену весов под тем же именем (проверка отпечатка).
  drift: boolean;
}

const tokens = (text: string): string[] => text.toLowerCase().replace(/ё/gu, 'е').match(/[\p{L}\p{N}]+/gu) ?? [];

export class FakeEmbeddings implements IModelGatewayEmbeddings {
  readonly kind = 'fake' as const;
  readonly model: string;
  readonly revision: string;
  readonly batchSize: number;
  readonly dim: number;
  readonly behaviour: IFakeBehaviour = { unavailable: false, wrongDim: null, delayMs: 0, drift: false };
  calls = 0;
  embeddedTexts = 0;

  constructor(o: IFakeEmbeddingsOptions = {}) {
    this.dim = o.dim ?? 64;
    this.model = o.model ?? `fake-hash-${this.dim}`;
    this.revision = o.revision ?? 'fake-1';
    this.batchSize = o.batchSize ?? 32;
  }

  vectorOf(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (const t of tokens(text)) {
      // Грубый «стемминг»: первые 5 символов слова, чтобы падежи сближались.
      const h = createHash('sha256').update(t.slice(0, 5)).digest();
      const i = h.readUInt32BE(0) % this.dim;
      v[i]! += h[4]! & 1 ? 1 : -1;
    }
    if (this.behaviour.drift) v[0]! += 5;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => Math.round((x / norm) * 1e4) / 1e4);
  }

  async embed(input: { texts: string[]; purpose: 'index' | 'query'; signal?: AbortSignal }): Promise<EmbeddingResult<IEmbedOutput>> {
    this.calls += 1;
    if (this.behaviour.delayMs > 0) await new Promise((r) => setTimeout(r, this.behaviour.delayMs));
    if (this.behaviour.unavailable) return embeddingError('UNAVAILABLE', 'model_unavailable', 'поддельная модель выключена', true);
    this.embeddedTexts += input.texts.length;
    const vectors = input.texts.map((t) => {
      const v = this.vectorOf(t);
      return this.behaviour.wrongDim ? [...v, ...new Array<number>(Math.max(0, this.behaviour.wrongDim - v.length)).fill(0)].slice(0, this.behaviour.wrongDim) : v;
    });
    return validateVectors(vectors, input.texts.length, this.behaviour.wrongDim ? null : this.dim, MAX_EMBEDDING_DIM);
  }

  async probe(): Promise<EmbeddingResult<IModelProbe>> {
    const r = await this.embed({ texts: [PROBE_TEXT], purpose: 'index' });
    if (!r.ok) return r;
    return { ok: true, value: { model: this.model, dim: r.value.dim, probe: r.value.vectors[0]! } };
  }
}
