import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpHandler } from '../src/mcp/handler.js';
import type { McpDeps } from '../src/mcp/tools.js';

/**
 * Protocol versions on /mcp, as AI hosts send them, without a database: tools/list and
 * initialize need no deps. The snapshot pins what the Claude and ChatGPT directory reviews
 * approved (tool names, descriptions, schemas, annotations, instructions): an SDK upgrade must
 * not change it.
 */
let server: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.post('/mcp', (req, _res, next) => {
    req.auth = { token: 't', clientId: 'c', scopes: ['site'], extra: { siteIds: [], permission: 'preview' } };
    next();
  }, express.json({ limit: '8mb' }), mcpHandler({} as McpDeps));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text.trimStart().startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
  return { status: res.status, json };
}

describe('2025-era clients (initialize handshake)', () => {
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    it(`initialize with ${version} gets that version back`, async () => {
      const { status, json } = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      expect(status).toBe(200);
      expect(json.result.protocolVersion).toBe(version);
      expect(json.result.serverInfo).toMatchObject({ name: 'crservers', title: 'CR Servers' });
    });
  }

  it('initialize result and tools/list are unchanged', async () => {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18' });
    expect(list.status).toBe(200);
    await expect(JSON.stringify({ instructions: init.json.result.instructions, capabilities: init.json.result.capabilities, tools: list.json.result.tools }, null, 2))
      .toMatchFileSnapshot('./__snapshots__/protocol.tools.json');
  });
});
