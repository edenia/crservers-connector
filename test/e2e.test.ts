import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgClientsStore } from '../src/auth/clients.js';
import type { ClientAreaApi, ClientAreaGrant } from '../src/auth/clientarea.js';
import { ConnectorOAuthProvider } from '../src/auth/provider.js';
import { verifyReq } from '../src/auth/req.js';
import { migrate } from '../src/db/migrate.js';
import { DeployCore } from '../src/deploy/core.js';
import { AuditLog, PgBlobStore, PgDraftStore, PgReleaseStore } from '../src/deploy/pgstores.js';
import { MemorySiteFs } from '../src/deploy/sitefs.js';
import { createApp } from '../src/http.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SiteRepo } from '../src/sites.js';

/**
 * Full authorization-code flow as an AI host drives it, against real Postgres and a fake
 * client area. Needs TEST_DATABASE_URL (CI provides one; locally: the crs-connector-pg container).
 */
const DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:54329/connector';
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CA_URL = 'https://clients.example.test';
const reqKey = randomBytes(32);
const schema = `t_${randomBytes(6).toString('hex')}`;

let pool: pg.Pool;
let server: Server;
let base: string;
/** What /.well-known/oauth-authorization-server says, and what iss must equal. */
let issuer: string;
let provider: ConnectorOAuthProvider;
/** The test site's files (in memory; FTPS in production). */
const siteFs = new MemorySiteFs({ 'index.html': '<h1>Lotes</h1><p>$50.000</p>', 'assets/a.css': 'a{}' });
siteFs.close = async () => undefined;
const caResults = new Map<string, ClientAreaGrant | null>();
const clientArea: ClientAreaApi = { exchange: async (code) => caResults.get(code) ?? null };

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: DB });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new pg.Pool({ connectionString: DB, options: `-c search_path=${schema}` });
  await migrate(pool);

  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const mcpUrl = `${base}/mcp`;
  issuer = base;
  const sites = new SiteRepo(pool, randomBytes(32));
  await sites.add({ serviceId: 15, domain: 'uat.example', ftpHost: 'iwx.test', ftpUser: 'crsconnect@uat.example', ftpPassword: 'pw' });
  provider = new ConnectorOAuthProvider({
    pool,
    clients: new PgClientsStore(pool, [CHATGPT]),
    sites,
    clientArea,
    issuer: base,
    mcpUrl,
    clientAreaUrl: CA_URL,
    reqKey,
  });
  const core = new DeployCore({ drafts: new PgDraftStore(pool), releases: new PgReleaseStore(pool), blobs: new PgBlobStore(pool) });
  const clientsForNames = new PgClientsStore(pool, [CHATGPT]);
  const mcp = { core, sites, audit: new AuditLog(pool), openFs: async () => siteFs, appName: (id: string) => clientsForNames.displayName(id) };
  server.on('request', createApp({ provider, issuer: base, mcpUrl, mcp }));
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

/** Raw JSON-RPC call to /mcp (stateless server: no initialize needed). */
async function mcpRaw(token: string | null, method: string, params: Record<string, unknown> = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
const siteInfo = async (token: string) => {
  const res = await mcpRaw(token, 'tools/call', { name: 'get_site_info', arguments: {} });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent : null };
};

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { redirect: 'manual', headers });
const form = (path: string, body: Record<string, string>) =>
  fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

async function register(): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CHATGPT], client_name: 'ChatGPT', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** /authorize → returns the signed req, the binding cookie and the PKCE verifier. */
async function startAuthorize(clientId: string, scope = 'site offline_access') {
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: CHATGPT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st-123', scope, resource: `${base}/mcp`,
  });
  const res = await get(`/authorize?${q}`);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe(`${CA_URL}/index.php`);
  const req = loc.searchParams.get('req')!;
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return { req, cookie, verifier, payload: verifyReq(reqKey, req)! };
}

describe('metadata', () => {
  it('advertises iss support, CIMD and offline_access', async () => {
    const m = (await (await get('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(issuer).toBe(base); // no trailing slash (RFC 8414 exact match)
    expect(m).toMatchObject({ issuer, authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true, code_challenge_methods_supported: ['S256'] });
    expect(m.scopes_supported).toContain('offline_access');
    const prm = (await (await get('/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${base}/mcp`);
    expect(prm.authorization_servers).toEqual([issuer]);
  });
});

describe('registration', () => {
  it('refuses redirect URIs outside the allowlist', async () => {
    const res = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
    expect(res.status).toBe(400);
  });
});

describe('authorization code flow', () => {
  it('signs a req the client-area extension can verify, naming the asking app', async () => {
    const { payload } = await startAuthorize(await register());
    expect(payload).toMatchObject({ app_name: 'ChatGPT', app_host: 'chatgpt.com' });
    expect(payload.rid).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('completes: client-area code → our code (with iss) → tokens → site-scoped access', async () => {
    const clientId = await register();
    const { cookie, verifier, payload } = await startAuthorize(clientId);
    caResults.set('ca-good', { client_id: 12, account_id: 15, domain: 'uat.example', server_id: '6', scope: 'publish' });

    const cb = await get(`/oauth/callback?code=ca-good&rid=${payload.rid}`, { cookie });
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(CHATGPT);
    expect(back.searchParams.get('state')).toBe('st-123');
    expect(back.searchParams.get('iss')).toBe(issuer);
    const code = back.searchParams.get('code')!;

    const tok = await form('/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CHATGPT, resource: `${base}/mcp` });
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(t.scope).toBe('site offline_access');

    const replay = await form('/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CHATGPT });
    expect(replay.status).toBe(400);

    expect((await siteInfo(t.access_token)).body).toMatchObject({ domain: 'uat.example', permission: 'publish' });

    const noAuth = await mcpRaw(null, 'tools/list');
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toContain('resource_metadata=');

    // Refresh rotation, then reuse of the old refresh token revokes the whole connection.
    const r1 = await form('/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    expect(r1.status).toBe(200);
    const t2 = (await r1.json()) as { access_token: string };
    expect((await siteInfo(t2.access_token)).status).toBe(200);
    const reuse = await form('/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect((await siteInfo(t2.access_token)).status).toBe(401);
  });

  it('wrong PKCE verifier is refused', async () => {
    const clientId = await register();
    const { cookie, payload } = await startAuthorize(clientId);
    caResults.set('ca-pkce', { client_id: 12, account_id: 15, domain: 'uat.example', server_id: '6', scope: 'publish' });
    const back = new URL((await get(`/oauth/callback?code=ca-pkce&rid=${payload.rid}`, { cookie })).headers.get('location')!);
    const tok = await form('/token', { grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: pkce().verifier, client_id: clientId });
    expect(tok.status).toBe(400);
  });

  it('serves branded HTML for the landing page and sign-in errors', async () => {
    const home = await get('/');
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(await home.text()).toContain('Conector de IA de CR Servers');
    const bad = await get('/oauth/callback?code=x&rid=nope');
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('La solicitud expiró');
  });

  it('the callback requires the browser that started the flow', async () => {
    const { payload } = await startAuthorize(await register());
    caResults.set('ca-x', { client_id: 12, account_id: 15, domain: 'uat.example', server_id: '6', scope: 'publish' });
    const res = await get(`/oauth/callback?code=ca-x&rid=${payload.rid}`, { cookie: 'crs_bind=attacker' });
    expect(res.status).toBe(400);
  });

  it.each([
    ['client cancels in the client area', 'error=access_denied', undefined],
    ['the client area refuses the code', 'code=ca-unknown', undefined],
    ['site not enabled yet', 'code=ca-nosite', { client_id: 12, account_id: 999, domain: 'other.example', server_id: '6', scope: 'publish' as const }],
  ])('%s → access_denied back to the AI host', async (_name, query, grant) => {
    const { cookie, payload } = await startAuthorize(await register());
    if (grant) caResults.set('ca-nosite', grant);
    const res = await get(`/oauth/callback?${query}&rid=${payload.rid}`, { cookie });
    const back = new URL(res.headers.get('location')!);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('iss')).toBe(issuer);
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('refuses tokens for another resource', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CHATGPT, code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' });
    const res = await get(`/authorize?${q}`);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });
});

/** Runs the whole sign-in and returns an access token for the given client-area permission. */
async function connect(permission: 'publish' | 'preview'): Promise<string> {
  const clientId = await register();
  const { cookie, verifier, payload } = await startAuthorize(clientId);
  const caCode = `ca-${permission}-${payload.rid}`;
  caResults.set(caCode, { client_id: 12, account_id: 15, domain: 'uat.example', server_id: '6', scope: permission });
  const back = new URL((await get(`/oauth/callback?code=${caCode}&rid=${payload.rid}`, { cookie })).headers.get('location')!);
  const tok = await form('/token', { grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, client_id: clientId });
  return ((await tok.json()) as { access_token: string }).access_token;
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test-ai-host', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

type Structured = Record<string, any>;
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), data: r.structuredContent as Structured, text: (r.content as { text: string }[])[0]?.text ?? '' };
};

describe('MCP tools end to end (signed in through the OAuth flow)', () => {
  it('lists tools with explicit annotations and server instructions', async () => {
    const c = await mcpClient(await connect('publish'));
    const { tools } = await c.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      ['delete_files', 'discard_changeset', 'edit_file', 'get_activity_log', 'get_site_info', 'get_usage_limits', 'list_files', 'list_releases', 'list_sites', 'preview_changeset', 'publish', 'read_file', 'revert_release', 'start_changeset', 'write_files'].sort(),
    );
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: expect.any(Boolean), destructiveHint: expect.any(Boolean), openWorldHint: expect.any(Boolean) });
    }
    expect(byName.publish!.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true, readOnlyHint: false });
    expect(byName.read_file!.annotations).toMatchObject({ readOnlyHint: true });
    expect(c.getInstructions()).toContain('preview_changeset');
    await c.close();
  });

  it('draft → write → (publish refused without preview) → preview → publish → revert', async () => {
    const c = await mcpClient(await connect('publish'));
    const read = await call(c, 'read_file', { path: 'index.html' });
    expect(read.data.text).toContain('$50.000');

    const { data: draft } = await call(c, 'start_changeset', { note: 'precio lote' });
    const w = await call(c, 'write_files', {
      changeset_id: draft.changeset_id,
      files: [
        { path: 'index.html', content: '<h1>Lotes</h1><p>$45.000</p>', base_hash: read.data.hash },
        { path: 'img/lote.png', content: Buffer.from([137, 80, 78, 71]).toString('base64'), encoding: 'base64' },
        { path: 'admin.php', content: '<?php system($_GET[1]);' },
      ],
    });
    expect(w.data.results.map((r: Structured) => r.ok)).toEqual([true, true, false]);
    expect(siteFs.text('index.html')).toContain('$50.000');

    const early = await call(c, 'publish', { changeset_id: draft.changeset_id });
    expect(early.isError).toBe(true);
    expect(early.text).toContain('preview_changeset');

    const pv = await call(c, 'preview_changeset', { changeset_id: draft.changeset_id });
    expect(pv.data).toMatchObject({ added: ['img/lote.png'], modified: ['index.html'], deleted: [], ready_to_publish: true });

    const pub = await call(c, 'publish', { changeset_id: draft.changeset_id });
    expect(pub.isError).toBe(false);
    expect(pub.text).toContain(`#${pub.data.release}`);
    expect(siteFs.text('index.html')).toContain('$45.000');
    expect(siteFs.files.has('img/lote.png')).toBe(true);

    const rels = await call(c, 'list_releases');
    expect(rels.data.releases[0]).toMatchObject({ release: pub.data.release, cause: 'publish' });

    const rev = await call(c, 'revert_release', { release: pub.data.release });
    expect(rev.isError).toBe(false);
    expect(siteFs.text('index.html')).toContain('$50.000');
    expect(siteFs.files.has('img/lote.png')).toBe(false);

    const log = await call(c, 'get_activity_log', { limit: 10 });
    expect(log.data.events.map((e: Structured) => e.action)).toEqual(['revert', 'publish', 'start_changeset']);
    expect(new Set(log.data.events.map((e: Structured) => e.by_app))).toEqual(new Set(['ChatGPT']));
    await c.close();
  });

  it('a preview-only connection cannot publish or revert', async () => {
    const c = await mcpClient(await connect('preview'));
    const { data: draft } = await call(c, 'start_changeset');
    await call(c, 'write_files', { changeset_id: draft.changeset_id, files: [{ path: 'x.html', content: 'x' }] });
    await call(c, 'preview_changeset', { changeset_id: draft.changeset_id });
    const pub = await call(c, 'publish', { changeset_id: draft.changeset_id });
    expect(pub.isError).toBe(true);
    expect(pub.text).toContain('preview');
    expect(siteFs.files.has('x.html')).toBe(false);
    expect((await call(c, 'revert_release', { release: 1 })).isError).toBe(true);
    await c.close();
  });

  it('a draft survives across requests (stored in Postgres) and is per-site', async () => {
    const token = await connect('publish');
    const c1 = await mcpClient(token);
    const { data: draft } = await call(c1, 'start_changeset');
    await call(c1, 'write_files', { changeset_id: draft.changeset_id, files: [{ path: 'p.html', content: 'persisted' }] });
    await c1.close();
    const c2 = await mcpClient(token);
    const r = await call(c2, 'read_file', { path: 'p.html', changeset_id: draft.changeset_id });
    expect(r.data.text).toBe('persisted');
    expect((await call(c2, 'read_file', { path: 'p.html', changeset_id: '00000000-0000-0000-0000-000000000000' })).isError).toBe(true);
    await c2.close();
  });
});

describe('large files', () => {
  it('read_file pages through big text files; edit_file changes part of them', async () => {
    const big = `<html><head><title>Inicio</title></head><body>${'<p>relleno</p>'.repeat(4000)}<footer>Precio: $50.000</footer></body></html>`;
    siteFs.put('grande.html', big);
    const c = await mcpClient(await connect('publish'));

    const p1 = await call(c, 'read_file', { path: 'grande.html' });
    expect(p1.data.total_chars).toBe(big.length);
    expect(p1.data.text.length).toBe(20_000);
    expect(p1.data.next_offset).toBe(20_000);
    const last = await call(c, 'read_file', { path: 'grande.html', offset: big.length - 100 });
    expect(last.data.next_offset).toBeNull();
    expect(last.data.text).toContain('$50.000');

    const { data: draft } = await call(c, 'start_changeset');
    const ambiguous = await call(c, 'edit_file', { changeset_id: draft.changeset_id, path: 'grande.html', edits: [{ old_text: '<p>relleno</p>', new_text: 'x' }] });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain('4000');
    const stale = await call(c, 'edit_file', { changeset_id: draft.changeset_id, path: 'grande.html', base_hash: 'nope', edits: [{ old_text: 'Inicio', new_text: 'x' }] });
    expect(stale.isError).toBe(true);

    const ed = await call(c, 'edit_file', {
      changeset_id: draft.changeset_id,
      path: 'grande.html',
      base_hash: p1.data.hash,
      edits: [
        { old_text: '<title>Inicio</title>', new_text: '<title>Lotes en Turrialba</title>' },
        { old_text: '$50.000', new_text: '$45.000' },
      ],
    });
    expect(ed.isError).toBe(false);
    expect(siteFs.text('grande.html')).toContain('$50.000'); // live untouched until publish
    const draftText = (await call(c, 'read_file', { path: 'grande.html', changeset_id: draft.changeset_id, offset: big.length - 100 })).data.text;
    expect(draftText).toContain('$45.000');
    await call(c, 'preview_changeset', { changeset_id: draft.changeset_id });
    await call(c, 'publish', { changeset_id: draft.changeset_id });
    expect(siteFs.text('grande.html')).toContain('<title>Lotes en Turrialba</title>');
    expect(siteFs.text('grande.html')).toContain('$45.000');
    await c.close();
  });
});
