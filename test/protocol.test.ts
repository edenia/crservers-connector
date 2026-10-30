import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as HttpV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client as ClientV2, StreamableHTTPClientTransport as HttpV2 } from '@modelcontextprotocol/client';
import { mcpHandler } from '../src/mcp/handler.js';
import { INSTRUCTIONS, type McpDeps } from '../src/mcp/tools.js';

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
  if (!text) return { status: res.status, type: res.headers.get('content-type'), json: null };
  const json = text.trimStart().startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
  return { status: res.status, type: res.headers.get('content-type'), json };
}

describe('2025-era clients (initialize handshake)', () => {
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    it(`initialize with ${version} gets that version back`, async () => {
      const { status, type, json } = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      expect(status).toBe(200);
      expect(type).toContain('application/json');
      expect(json.result.protocolVersion).toBe(version);
      expect(json.result.serverInfo).toMatchObject({ name: 'crservers', title: 'CR Servers' });
    });
  }

  it('bodies over the SDK\'s 4 MiB default are accepted (write_files allows 5 MB per call)', async () => {
    const args = { changeset_id: 'x', files: [{ path: 'a.txt', content: 'a'.repeat(5_500_000) }] };
    const legacy = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_files', arguments: args } }, { 'mcp-protocol-version': '2025-06-18' });
    expect(legacy.status).toBe(200);
    expect(legacy.json.result ?? legacy.json.error).toBeDefined();
  });

  it('initialize result and tools/list are unchanged', async () => {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18' });
    expect(list.status).toBe(200);
    await expect(JSON.stringify({ instructions: init.json.result.instructions, capabilities: init.json.result.capabilities, tools: list.json.result.tools }, null, 2))
      .toMatchFileSnapshot('./__snapshots__/protocol.tools.json');
  });
});

/** What a 2026-07-28 client puts on every request (ChatGPT's Codex client: openai-mcp/1.0.0). */
function modern(method: string, version = '2026-07-28', params: Record<string, unknown> = {}) {
  const meta = {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name: 'openai-mcp', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const name = typeof params.name === 'string' ? { 'mcp-name': params.name } : {};
  return post({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }, { 'mcp-protocol-version': version, 'mcp-method': method, ...name });
}

describe('2026-07-28 clients (server/discover, per-request version)', () => {
  it('server/discover answers 200 with the supported version and the instructions', async () => {
    const { status, json } = await modern('server/discover');
    expect(status).toBe(200);
    expect(json.result.supportedVersions).toContain('2026-07-28');
    expect(json.result.instructions).toBe(INSTRUCTIONS);
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it('tools/list is the approved listing (the 2026 schema has no execution field)', async () => {
    const now = await modern('tools/list');
    const old = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18' });
    expect(now.status).toBe(200);
    const approved = old.json.result.tools.map(({ execution: _e, ...t }: { execution?: unknown }) => t);
    expect(now.json.result.tools).toEqual(approved);
  });

  it('bodies over the SDK\'s 4 MiB default are accepted', async () => {
    const r = await modern('tools/call', '2026-07-28', { name: 'write_files', arguments: { changeset_id: 'x', files: [{ path: 'a.txt', content: 'a'.repeat(5_500_000) }] } });
    expect(r.status).toBe(200);
    expect(r.json.result ?? r.json.error).toBeDefined();
  });

  it('an unknown version gets UnsupportedProtocolVersionError naming the supported ones', async () => {
    const { json } = await modern('server/discover', '2099-01-01');
    expect(json.error.code).toBe(-32022);
    expect(json.error.data.supported).toContain('2026-07-28');
  });
});

describe('SDK clients', () => {
  const auth = { requestInit: { headers: { authorization: 'Bearer t' } } };

  it('a negotiating v2 client (auto) stays on 2026-07-28', async () => {
    const c = new ClientV2({ name: 'v2', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(new HttpV2(new URL(url), auth));
    expect(c.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('publish');
    await c.close();
  });

  it('a v1 client still connects with initialize', async () => {
    const c = new ClientV1({ name: 'v1', version: '1' });
    await c.connect(new HttpV1(new URL(url), auth));
    expect(c.getServerVersion()?.name).toBe('crservers');
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('publish');
    await c.close();
  });
});
