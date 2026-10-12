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
import { PreviewService } from '../src/preview/preview.js';
import { ApprovalService, approvalReasons } from '../src/approvals/approvals.js';
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
const siteFs = new MemorySiteFs({ 'index.html': '<h1>Inicio</h1>', 'lotes.html': '<h1>Lotes</h1><p>$50.000</p>', 'assets/a.css': 'a{}' });
siteFs.close = async () => undefined;
const caResults = new Map<string, ClientAreaGrant | null>();
const liveFetches: string[] = [];
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
  // The "live site" for previews: the in-memory site files, as the web server would serve them.
  const fetchLive = async (url: string) => {
    liveFetches.push(url);
    const u = new URL(url);
    if (u.pathname === '/old') return new Response(null, { status: 301, headers: { location: `https://uat.example/new?x=1` } });
    const path = decodeURIComponent(u.pathname.slice(1)) || 'index.html';
    const f = siteFs.files.get(path.endsWith('/') ? `${path}index.html` : path);
    if (!f) return new Response('nope', { status: 404 });
    const type = path.endsWith('.css') ? 'text/css' : path.endsWith('.html') || path === '' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    return new Response(new Uint8Array(f.data), { status: 200, headers: { 'content-type': type } });
  };
  const preview = new PreviewService(pool, sites, base, fetchLive);
  const audit = new AuditLog(pool);
  const appName = (id: string) => clientsForNames.displayName(id);
  const approvals = new ApprovalService({ pool, sites, core, audit, openFs: async () => siteFs, preview, clientArea, clientAreaUrl: CA_URL, reqKey, publicUrl: base, appName });
  const mcp = { core, sites, preview, approvals, audit, openFs: async () => siteFs, appName };
  server.on('request', createApp({ provider, issuer: base, mcpUrl, mcp, preview, approvals }));
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
    const en = await get('/', { 'accept-language': 'en-US,en;q=0.9,es;q=0.5' });
    expect(await en.text()).toContain('CR Servers AI connector');
    const esPref = await get('/', { 'accept-language': 'es-CR,es;q=0.9,en;q=0.8' });
    expect(await esPref.text()).toContain('Conector de IA de CR Servers');
    const enErr = await get('/oauth/callback?code=x&rid=nope', { 'accept-language': 'en' });
    expect(await enErr.text()).toContain('This request expired');
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
    const read = await call(c, 'read_file', { path: 'lotes.html' });
    expect(read.data.text).toContain('$50.000');

    const { data: draft } = await call(c, 'start_changeset', { note: 'precio lote' });
    const w = await call(c, 'write_files', {
      changeset_id: draft.changeset_id,
      files: [
        { path: 'lotes.html', content: '<h1>Lotes</h1><p>$45.000</p>', base_hash: read.data.hash },
        { path: 'img/lote.png', content: Buffer.from([137, 80, 78, 71]).toString('base64'), encoding: 'base64' },
        { path: 'admin.php', content: '<?php system($_GET[1]);' },
      ],
    });
    expect(w.data.results.map((r: Structured) => r.ok)).toEqual([true, true, false]);
    expect(siteFs.text('lotes.html')).toContain('$50.000');

    const early = await call(c, 'publish', { changeset_id: draft.changeset_id });
    expect(early.isError).toBe(true);
    expect(early.text).toContain('preview_changeset');

    const pv = await call(c, 'preview_changeset', { changeset_id: draft.changeset_id });
    expect(pv.data).toMatchObject({ added: ['img/lote.png'], modified: ['lotes.html'], deleted: [], ready_to_publish: true });

    const pub = await call(c, 'publish', { changeset_id: draft.changeset_id });
    expect(pub.isError).toBe(false);
    expect(pub.text).toContain(`#${pub.data.release}`);
    expect(siteFs.text('lotes.html')).toContain('$45.000');
    expect(siteFs.files.has('img/lote.png')).toBe(true);

    const rels = await call(c, 'list_releases');
    expect(rels.data.releases[0]).toMatchObject({ release: pub.data.release, cause: 'publish' });

    const rev = await call(c, 'revert_release', { release: pub.data.release });
    expect(rev.isError).toBe(false);
    expect(siteFs.text('lotes.html')).toContain('$50.000');
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

describe('preview links', () => {
  it('shows the draft as the site would look, sandboxed, with live files filling the gaps', async () => {
    siteFs.put('assets/site.css', 'body{background:url(/img/bg.png)}');
    const c = await mcpClient(await connect('publish'));
    const { data: draft } = await call(c, 'start_changeset');
    await call(c, 'write_files', {
      changeset_id: draft.changeset_id,
      files: [
        { path: 'nuevo.html', content: '<html><head><title>N</title><link href="/assets/site.css" rel="stylesheet"></head><body><a href="https://uat.example/contacto.html">c</a><img srcset="/a.png 1x, /b.png 2x"><a href="https://otro.example/">x</a></body></html>' },
        { path: 'docs/index.html', content: '<p>docs borrador</p>' },
      ],
    });
    await call(c, 'delete_files', { changeset_id: draft.changeset_id, paths: ['assets/a.css'] });
    const pv = await call(c, 'preview_changeset', { changeset_id: draft.changeset_id });
    const url = new URL(pv.data.preview_url);
    expect(url.pathname).toMatch(/^\/p\/[A-Za-z0-9_-]{32}\/$/);
    expect(pv.text).toContain(pv.data.preview_url);
    const prefix = url.pathname.slice(0, -1);

    const page = await get(`${prefix}/nuevo.html`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox /);
    expect(page.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    expect(page.headers.get('x-robots-tag')).toContain('noindex');
    const html = await page.text();
    expect(html).toContain(`href="${prefix}/assets/site.css"`);
    expect(html).toContain(`href="${prefix}/contacto.html"`);
    expect(html).toContain(`srcset="${prefix}/a.png 1x, ${prefix}/b.png 2x"`);
    expect(html).toContain('href="https://otro.example/"');
    expect(html).toContain('Vista previa de un borrador: uat.example');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');

    // Not in the draft: comes from the live site (CSS rewritten too).
    const css = await get(`${prefix}/assets/site.css`);
    expect(await css.text()).toBe(`body{background:url(${prefix}/img/bg.png)}`);
    // Directory index from the draft; deleted in the draft → 404 even though it's live.
    expect(await (await get(`${prefix}/docs/`)).text()).toContain('docs borrador');
    expect((await get(`${prefix}/assets/a.css`)).status).toBe(404);
    // Live redirects stay inside the preview.
    const redir = await get(`${prefix}/old`);
    expect(redir.headers.get('location')).toBe(`${prefix}/new?x=1`);
    // Live home page, English banner.
    expect(await (await get(`${prefix}/`, { 'accept-language': 'en' })).text()).toContain('Draft preview: uat.example');
    expect(liveFetches.every((u) => u.startsWith('https://uat.example/'))).toBe(true);
    // Only GET.
    expect((await fetch(`${base}${prefix}/nuevo.html`, { method: 'POST' })).status).toBe(405);

    // Gone once the draft is discarded (or published).
    await call(c, 'discard_changeset', { changeset_id: draft.changeset_id });
    const gone = await get(`${prefix}/nuevo.html`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain('ya no está disponible');
    await c.close();
  });

  it('unknown tokens get the expired page', async () => {
    const res = await get('/p/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox /);
  });
});

describe('approval link', () => {
  it('flags many files, deletions, the home page, and "approve every publish"', () => {
    const none = { added: ['a.html'], modified: ['b/index.html'], deleted: [] as string[] };
    expect(approvalReasons(none, { approveEveryPublish: false })).toEqual([]);
    expect(approvalReasons(none, { approveEveryPublish: true })).toEqual(['always']);
    expect(approvalReasons({ added: Array.from({ length: 20 }, (_, i) => `p${i}.html`), modified: [], deleted: [] }, { approveEveryPublish: false })).toEqual(['many_files']);
    expect(approvalReasons({ added: [], modified: ['index.html'], deleted: ['old.png'] }, { approveEveryPublish: false })).toEqual(['deletes', 'home_page']);
  });

  const cookiesOf = (res: globalThis.Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]!);

  /** Opens the approval link and signs in through the (fake) client area as the given service. */
  async function signInToApprove(approvalUrl: string, accountId = 15, scope: 'approve' | 'publish' = 'approve') {
    const path = new URL(approvalUrl).pathname;
    const start = await get(path);
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(`${CA_URL}/index.php`);
    const payload = verifyReq(reqKey, loc.searchParams.get('req')!)!;
    expect(payload).toMatchObject({ purpose: 'approve', service_id: 15, app_name: 'ChatGPT' });
    const bind = cookiesOf(start).find((c) => c.startsWith('crs_abind='))!;
    const code = `ca-approve-${payload.rid}`;
    caResults.set(code, { client_id: 12, account_id: accountId, domain: 'uat.example', server_id: '6', scope });
    const cb = await get(`/oauth/callback?code=${code}&rid=${payload.rid}`, { cookie: bind });
    const session = cookiesOf(cb).find((c) => c.startsWith('crs_appr='));
    return { path, cb, session };
  }

  async function draftTouchingHome(c: Client, text = '<h1>Inicio nuevo</h1>') {
    const { data: draft } = await call(c, 'start_changeset');
    await call(c, 'write_files', { changeset_id: draft.changeset_id, files: [{ path: 'index.html', content: text }] });
    await call(c, 'preview_changeset', { changeset_id: draft.changeset_id });
    return draft.changeset_id as string;
  }

  it('home page change: publish returns a link; the owner signs in, sees it and publishes', async () => {
    const before = siteFs.text('index.html');
    const c = await mcpClient(await connect('publish'));
    const id = await draftTouchingHome(c);

    const pub = await call(c, 'publish', { changeset_id: id });
    expect(pub.isError).toBe(false);
    expect(pub.data).toMatchObject({ needs_approval: true, reasons: ['home_page'] });
    expect(pub.data.approval_url).toMatch(new RegExp(`^${base}/approve/[0-9a-f-]{36}$`));
    expect(siteFs.text('index.html')).toBe(before);
    expect((await call(c, 'publish', { changeset_id: id })).data.approval_url).toBe(pub.data.approval_url); // same pending request

    const { path, cb, session } = await signInToApprove(pub.data.approval_url);
    expect(cb.status).toBe(303);
    expect(cb.headers.get('location')).toBe(path);
    const pageRes = await get(path, { cookie: session! });
    expect(pageRes.headers.get('x-frame-options')).toBe('DENY');
    const html = await pageRes.text();
    expect(html).toContain('Aprobar publicación');
    expect(html).toContain('<code>index.html</code>');
    expect(html).toContain('Cambia la página de inicio.');
    expect(html).toMatch(/href="http:\/\/localhost:\d+\/p\/[A-Za-z0-9_-]{32}\/"/);

    const post = (headers: Record<string, string>) =>
      fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: 'decision=approve' });
    expect((await post({ cookie: session!, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ origin: base })).status).toBe(403); // no session
    const ok = await post({ cookie: session!, origin: base });
    expect(ok.status).toBe(303);
    expect(siteFs.text('index.html')).toBe('<h1>Inicio nuevo</h1>');
    expect(await (await get(path, { cookie: session! })).text()).toContain('Publicado');

    const after = await call(c, 'publish', { changeset_id: id });
    expect(after.data).toMatchObject({ approved_in_browser: true, release: expect.any(Number) });
    const log = await call(c, 'get_activity_log', { limit: 3 });
    expect(log.data.events[0]).toMatchObject({ action: 'publish', detail: { approved_in_browser: true } });
    await c.close();
  });

  it('another account, or a connection code, cannot approve', async () => {
    const c = await mcpClient(await connect('publish'));
    const id = await draftTouchingHome(c, '<h1>otro</h1>');
    const { data } = await call(c, 'publish', { changeset_id: id });
    const other = await signInToApprove(data.approval_url, 999);
    expect(other.cb.status).toBe(403);
    expect(await other.cb.text()).toContain('no administra este sitio');
    expect(other.session).toBeUndefined();
    const wrongScope = await signInToApprove(data.approval_url, 15, 'publish');
    expect(wrongScope.cb.status).toBe(403);
    await call(c, 'discard_changeset', { changeset_id: id });
    await c.close();
  });

  it('an approval code never becomes a connection', async () => {
    const { cookie, payload } = await startAuthorize(await register());
    caResults.set('ca-approve-scope', { client_id: 12, account_id: 15, domain: 'uat.example', server_id: '6', scope: 'approve' });
    const back = new URL((await get(`/oauth/callback?code=ca-approve-scope&rid=${payload.rid}`, { cookie })).headers.get('location')!);
    expect(back.searchParams.get('error')).toBe('access_denied');
  });

  it('refuses when the draft changed after approval was requested; reject is final for that version', async () => {
    const before = siteFs.text('index.html');
    const c = await mcpClient(await connect('publish'));
    const id = await draftTouchingHome(c, '<h1>v1</h1>');
    const { data } = await call(c, 'publish', { changeset_id: id });
    const { path, session } = await signInToApprove(data.approval_url);
    // The AI changes the draft (and even previews it again) while the owner is looking.
    await call(c, 'write_files', { changeset_id: id, files: [{ path: 'index.html', content: '<h1>v2 sneaky</h1>' }] });
    await call(c, 'preview_changeset', { changeset_id: id });
    expect((await get(path, { cookie: session! })).status).toBe(409);
    const post = await fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session!, origin: base }, body: 'decision=approve' });
    expect(post.status).toBe(409);
    expect(siteFs.text('index.html')).toBe(before);

    // The new version gets its own request; the owner rejects it.
    const v2 = await call(c, 'publish', { changeset_id: id });
    expect(v2.data.approval_url).not.toBe(data.approval_url);
    const s2 = await signInToApprove(v2.data.approval_url);
    const rej = await fetch(`${base}${s2.path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: s2.session!, origin: base }, body: 'decision=reject' });
    expect(rej.status).toBe(303);
    expect(await (await get(s2.path, { cookie: s2.session! })).text()).toContain('No se publicó');
    const again = await call(c, 'publish', { changeset_id: id });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('decidió no publicar');
    expect(siteFs.text('index.html')).toBe(before);
    await c.close();
  });
});
