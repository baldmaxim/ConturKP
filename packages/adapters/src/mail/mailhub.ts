// Официальный сервисный API MailHub. Только GET, без cookie человека и без изменения ящиков.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MAILHUB_CONTRACT = 'mailhub-service-read/1';
const Copy = z.object({
  mailboxId: z.uuid(),
  mailbox: z.string().min(1).max(64),
  folder: z.string().max(1000),
  role: z.string().max(40),
});
const Item = z.object({
  id: z.uuid(),
  messageId: z.string().nullable(),
  threadId: z.uuid().nullable(),
  changedAt: z.iso.datetime({ offset: true }),
  copies: z.array(Copy).max(1000),
});
const Page = z.object({
  contract: z.literal(MAILHUB_CONTRACT),
  items: z.array(Item).max(200),
  nextCursor: z.string().max(512).nullable(),
  hasMore: z.boolean(),
});
const Boxes = z.object({
  contract: z.literal(MAILHUB_CONTRACT),
  items: z
    .array(
      z.object({
        id: z.uuid(),
        slug: z.string(),
        title: z.string(),
        address: z.string(),
      }),
    )
    .max(200),
});
export type IMailHubItem = z.infer<typeof Item>;
export type IMailHubPage = z.infer<typeof Page>;

export class MailHubReadError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean) {
    super(`MailHub: ${code}`);
    this.code = code;
    this.retryable = retryable;
  }
}

export class MailHubReader {
  readonly sourceKey: string;
  private readonly url: URL;
  private readonly options: {
    baseUrl: string;
    token: string;
    maxEmlBytes: number;
    fetchImpl?: typeof fetch;
  };
  constructor(options: {
    baseUrl: string;
    token: string;
    maxEmlBytes: number;
    fetchImpl?: typeof fetch;
  }) {
    this.options = options;
    this.url = new URL(options.baseUrl);
    if (
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash ||
      this.url.pathname !== '/' ||
      !(
        this.url.protocol === 'https:' ||
        (this.url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname))
      )
    )
      throw new Error('MAILHUB_URL: нужен HTTPS origin');
    if (!options.token) throw new Error('MAILHUB_TOKEN не задан');
    this.sourceKey = createHash('sha256').update(this.url.origin).digest('hex');
  }
  private async get(
    path: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; sha: string | null }> {
    const deadline = AbortSignal.timeout(90_000);
    try {
      const res = await (this.options.fetchImpl ?? fetch)(
        new URL(path, this.url),
        {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            'Cache-Control': 'no-cache',
          },
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        },
      );
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new MailHubReadError(
          `HTTP_${res.status}`,
          res.status === 409 || res.status === 429 || res.status >= 500,
        );
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!res.body) throw new MailHubReadError('EMPTY_RESPONSE', true);
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > limit) {
            await reader.cancel();
            throw new MailHubReadError('RESPONSE_TOO_LARGE', false);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return {
        bytes: Buffer.concat(chunks),
        sha: res.headers.get('x-content-sha256'),
      };
    } catch (error) {
      if (error instanceof MailHubReadError) throw error;
      throw new MailHubReadError(
        deadline.aborted ? 'TIMEOUT' : 'UNAVAILABLE',
        true,
      );
    }
  }
  async mailboxes(signal?: AbortSignal) {
    const r = await this.get(
      '/api/v1/service/mail/mailboxes',
      2 * 1024 * 1024,
      signal,
    );
    try {
      return Boxes.parse(JSON.parse(r.bytes.toString('utf8'))).items;
    } catch {
      throw new MailHubReadError('CONTRACT_INVALID', false);
    }
  }
  async changes(
    cursor: string | null,
    since: string | null,
    signal?: AbortSignal,
  ): Promise<IMailHubPage> {
    const query = new URLSearchParams({ limit: '200' });
    if (cursor) query.set('cursor', cursor);
    if (since) query.set('since', since);
    if (!since) query.set('reverse', 'true');
    const r = await this.get(
      `/api/v1/service/mail/changes?${query}`,
      4 * 1024 * 1024,
      signal,
    );
    try {
      return Page.parse(JSON.parse(r.bytes.toString('utf8')));
    } catch {
      throw new MailHubReadError('CONTRACT_INVALID', false);
    }
  }
  async eml(id: string, signal?: AbortSignal): Promise<Buffer> {
    if (!z.uuid().safeParse(id).success)
      throw new MailHubReadError('INVALID_ITEM_ID', false);
    const r = await this.get(
      `/api/v1/service/mail/messages/${id}/eml`,
      this.options.maxEmlBytes,
      signal,
    );
    if (!r.sha || createHash('sha256').update(r.bytes).digest('hex') !== r.sha)
      throw new MailHubReadError('CHECKSUM_MISMATCH', false);
    return r.bytes;
  }
}
