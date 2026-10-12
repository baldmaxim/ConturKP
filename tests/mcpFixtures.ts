// Фикстуры этапа 16: MCP-сервер портала на настоящем HTTP и официальный клиент SDK. Это проверка протокола и
// инструментов, а не подключения Codex или Cursor (ADR-010): живая проверка клиентов выполняется отдельно.
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Express } from 'express';
import { expect } from 'vitest';
import type { TestClient } from './helpers.ts';

export interface IMcpEndpoint {
  url: string;
  close: () => Promise<void>;
}

export const startMcp = async (app: Express): Promise<IMcpEndpoint> => {
  const server: Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export const issueToken = async (client: TestClient, o: { propose?: boolean; name?: string; clientKind?: string; lifetimeDays?: number } = {}): Promise<{ id: string; token: string }> => {
  const r = await client.post('/me/api-tokens', { name: o.name ?? 'тест MCP', clientKind: o.clientKind ?? 'other', propose: o.propose ?? false, ...(o.lifetimeDays ? { lifetimeDays: o.lifetimeDays } : {}) });
  expect(r.status, r.text).toBe(201);
  return { id: r.body.id as string, token: r.body.token as string };
};

export const mcpClient = async (url: string, token: string): Promise<Client> => {
  const client = new Client({ name: 'kontur-test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
};

export interface IToolReply {
  isError: boolean;
  body: any;
  text: string;
}

// Вызов инструмента: результат — один текстовый блок с JSON.
export const callTool = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<IToolReply> => {
  const r = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
  expect(r.content, name).toHaveLength(1);
  const text = r.content![0]!.text ?? '';
  return { isError: r.isError === true, body: JSON.parse(text), text };
};

// Сырой запрос к точке: проверка HTTP-уровня (методы, Origin, токен) без клиента SDK.
export const rawPost = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<globalThis.Response> =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
