import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgClientsStore } from '../src/auth/clients.js';
import type { ClientAreaApi, ClientAreaGrant, LayoutSite } from '../src/auth/clientarea.js';
import { DEFAULT_REDIRECT_ALLOWLIST } from '../src/config.js';
import { LayoutSync } from '../src/auth/layout.js';
import { ConnectorOAuthProvider } from '../src/auth/provider.js';
import { verifyReq } from '../src/auth/req.js';
import { migrate } from '../src/db/migrate.js';
import { DeployCore } from '../src/deploy/core.js';
import { AuditLog, PgBlobStore, PgDraftStore, PgReleaseStore } from '../src/deploy/pgstores.js';
import { SupportLog } from '../src/db/support.js';
import { MemorySiteFs } from '../src/deploy/sitefs.js';
import { createApp } from '../src/http.js';
import { PreviewService } from '../src/preview/preview.js';
import { ApprovalService, approvalReasons } from '../src/approvals/approvals.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client as ClientV2, StreamableHTTPClientTransport as HttpV2 } from '@modelcontextprotocol/client';
import { SiteRepo } from '../src/sites.js';
import { skeletonFiles } from './fixtures/skeleton.js';

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
let sitesRepo: SiteRepo;
/** The client area's current layout per hosting service; unset = what the connector already stores. */
const layouts = new Map<number, LayoutSite[] | 'down'>();
const clientArea: ClientAreaApi = {
  exchange: async (code) => caResults.get(code) ?? null,
  layout: async (serviceId) => {
    const l = layouts.get(serviceId);
    if (l === 'down') throw new Error('client area down');
    return l ?? (await sitesRepo.byService(serviceId)).map((s) => ({ domain: s.domain, kind: s.kind, protected_dirs: s.protectedDirs }));
  },
};

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
    clients: new PgClientsStore(pool, DEFAULT_REDIRECT_ALLOWLIST), // the production defaults (includes ChatGPT)
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
  // maxAge 0: every call asks the (fake) client area, so layout changes show up immediately.
  const layout = new LayoutSync(sites, clientArea, 0);
  const approvals = new ApprovalService({ pool, sites, core, audit, openFs: async () => siteFs, preview, clientArea, clientAreaUrl: CA_URL, reqKey, publicUrl: base, appName, layout });
  const fetchUrl = async (url: string) => {
    if (url.endsWith('/foto.png')) return { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), contentType: 'image/png', finalUrl: url };
    return { data: Buffer.from('<!doctype html><p>login</p>'), contentType: 'text/html', finalUrl: url };
  };
  const mcp = { core, sites, preview, approvals, audit, openFs: async () => siteFs, appName, fetchUrl, layout, support: new SupportLog(pool) };
  sitesRepo = sites;
  const clientApi = { pool, sites, audit, appName, reqKey, removeSite: (grantId: string, siteId: string) => provider.removeSite(grantId, siteId) };
  server.on('request', createApp({ provider, issuer: base, mcpUrl, mcp, preview, approvals, clientApi, openaiAppsChallenge: 'test-challenge-token', events: { pool, sites, reqKey }, registrationRateLimit: false }));
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

  it('accepts loopback callbacks on any port for apps on the user\'s computer (Claude Code)', async () => {
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], client_name: 'Claude Code', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: 'http://localhost:51873/callback', code_challenge: challenge,
      code_challenge_method: 'S256', state: 's', scope: 'site', resource: `${base}/mcp`,
    });
    const res = await get(`/authorize?${q}`);
    expect(res.status).toBe(302);
    const req = verifyReq(reqKey, new URL(res.headers.get('location')!).searchParams.get('req')!)!;
    expect(req).toMatchObject({ app_name: 'Claude Code', app_host: 'localhost' });

    for (const bad of ['https://localhost/callback', 'http://localhost.evil.example/callback', 'http://user@localhost/callback']) {
      const r = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [bad] }) });
      expect(r.status, bad).toBe(400);
    }
  });
});

describe('registration with several callbacks (Cursor, VS Code)', () => {
  it('keeps the allowed callbacks, drops the rest, and only accepts a kept one at authorize', async () => {
    for (const [name, uris, kept] of [
      ['Cursor', ['cursor://anysphere.cursor-mcp/oauth/callback', 'https://www.cursor.com/agents/mcp/oauth/callback', 'http://localhost:8787/callback'], ['https://www.cursor.com/agents/mcp/oauth/callback', 'http://localhost:8787/callback']],
      ['Visual Studio Code', ['https://vscode.dev/redirect', 'https://insiders.vscode.dev/redirect', 'http://127.0.0.1:33418/'], ['http://127.0.0.1:33418/']],
    ] as const) {
      const reg = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: uris, client_name: name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }),
      });
      expect(reg.status, name).toBe(201);
      const body = (await reg.json()) as { client_id: string; redirect_uris: string[] };
      expect(body.redirect_uris, name).toEqual(kept);

      const { challenge } = pkce();
      const q = (redirect: string) => new URLSearchParams({
        response_type: 'code', client_id: body.client_id, redirect_uri: redirect, code_challenge: challenge,
        code_challenge_method: 'S256', state: 's', scope: 'site', resource: `${base}/mcp`,
      });
      const ok = await get(`/authorize?${q(kept[0]!)}`);
      expect(ok.status, name).toBe(302);
      expect(new URL(ok.headers.get('location')!).searchParams.get('req'), name).toBeTruthy();
      const dropped = await get(`/authorize?${q(uris[0]!)}`);
      expect(dropped.status, `${name} dropped callback`).toBe(400);
    }
  });

  it('accepts Warp\'s app callback (exact match only) and names it as an app on this computer', async () => {
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['warp://mcp/oauth2callback'], client_name: 'Warp', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: 'warp://mcp/oauth2callback', code_challenge: challenge,
      code_challenge_method: 'S256', state: 's', scope: 'site', resource: `${base}/mcp`,
    });
    const res = await get(`/authorize?${q}`);
    expect(res.status).toBe(302);
    const req = verifyReq(reqKey, new URL(res.headers.get('location')!).searchParams.get('req')!)!;
    expect(req).toMatchObject({ app_name: 'Warp', app_host: 'localhost' });
    for (const bad of ['warp://evil/oauth2callback', 'warp://mcp/other', 'myapp://mcp/oauth2callback']) {
      const r = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [bad] }) });
      expect(r.status, bad).toBe(400);
    }
  });

  it('still refuses a registration where no callback is allowed', async () => {
    const res = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['cursor://x/cb', 'https://evil.example/cb'] }) });
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

  it('issues a refresh token even when the client asks only for "site" (ChatGPT does)', async () => {
    const clientId = await register();
    const { cookie, verifier, payload } = await startAuthorize(clientId, 'site');
    caResults.set('ca-site-only', { client_id: 12, account_id: 15, domain: 'uat.example', server_id: '6', scope: 'publish' });
    const back = new URL((await get(`/oauth/callback?code=ca-site-only&rid=${payload.rid}`, { cookie })).headers.get('location')!);
    const tok = await form('/token', { grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, client_id: clientId });
    const t = (await tok.json()) as { access_token: string; refresh_token?: string; scope: string };
    expect(t.refresh_token).toBeTruthy();
    expect(t.scope).toBe('site offline_access');
    const r = await form('/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: clientId });
    expect(r.status).toBe(200);
    expect((await siteInfo(((await r.json()) as { access_token: string }).access_token)).status).toBe(200);
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
    const homeHtml = await home.text();
    expect(homeHtml).toContain('CR Servers AI Connect');
    expect(homeHtml).toContain('lang="es"');
    const bad = await get('/oauth/callback?code=x&rid=nope');
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('La solicitud expiró');
    const en = await get('/', { 'accept-language': 'en-US,en;q=0.9,es;q=0.5' });
    expect(await en.text()).toContain('lang="en"');
    const esPref = await get('/', { 'accept-language': 'es-CR,es;q=0.9,en;q=0.8' });
    expect(await esPref.text()).toContain('lang="es"');
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
let sharedClientId: string | undefined; // /register is rate limited per IP
async function connect(permission: 'publish' | 'preview'): Promise<string> {
  const clientId = (sharedClientId ??= await register());
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
      ['add_attachments', 'delete_files', 'discard_changeset', 'edit_file', 'import_from_url', 'get_activity_log', 'get_site_info', 'get_usage_limits', 'list_files', 'list_releases', 'list_sites', 'preview_changeset', 'publish', 'read_file', 'revert_release', 'start_changeset', 'write_files'].sort(),
    );
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: expect.any(Boolean), destructiveHint: expect.any(Boolean), openWorldHint: expect.any(Boolean) });
      // Claude's directory reads the display name from annotations.title.
      expect(t.annotations?.title, t.name).toBe(t.title);
      expect(t.title, t.name).toBeTruthy();
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

describe('placeholder files of a new hosting account', () => {
  /** Runs `fn` with the site holding only the skeleton, then puts the usual test files back. */
  async function onFreshSite(fn: () => Promise<void>) {
    const saved = new Map(siteFs.files);
    siteFs.files.clear();
    for (const [p, d] of Object.entries(skeletonFiles('uat.example'))) siteFs.put(p, d);
    try {
      await fn();
    } finally {
      siteFs.files.clear();
      for (const [p, f] of saved) siteFs.files.set(p, f);
    }
  }

  it('the first home page removes them; the preview says so; revert brings them back', () =>
    onFreshSite(async () => {
      const before = new Map([...siteFs.files].map(([p, f]) => [p, f.data]));
      const c = await mcpClient(await connect('publish'));
      const { data: draft } = await call(c, 'start_changeset');
      await call(c, 'write_files', { changeset_id: draft.changeset_id, files: [{ path: 'index.html', content: '<h1>Café</h1>' }] });
      const pv = await call(c, 'preview_changeset', { changeset_id: draft.changeset_id });
      expect(pv.data).toMatchObject({
        modified: ['index.html'],
        deleted: ['crservers-logo.svg', 'index.html.orig', 'robots.txt'],
        placeholder_files_removed: ['crservers-logo.svg', 'index.html.orig', 'robots.txt'],
        ready_to_publish: true,
      });
      expect(pv.text).toContain('placeholder files every new hosting account starts with');
      expect(pv.text).not.toMatch(/siteworx|interworx/i);

      const pub = await call(c, 'publish', { changeset_id: draft.changeset_id });
      expect(pub.isError).toBe(false);
      expect([...siteFs.files.keys()]).toEqual(['index.html']);

      expect((await call(c, 'revert_release', { release: pub.data.release })).isError).toBe(false);
      expect(new Map([...siteFs.files].map(([p, f]) => [p, f.data]))).toEqual(before);
      await c.close();
    }));

  it('with index.htm as the new home page, the preview shows it rather than a missing index.html', () =>
    onFreshSite(async () => {
      const c = await mcpClient(await connect('publish'));
      const { data: draft } = await call(c, 'start_changeset');
      await call(c, 'write_files', { changeset_id: draft.changeset_id, files: [{ path: 'index.htm', content: '<h1>Café nuevo</h1>' }] });
      const pv = await call(c, 'preview_changeset', { changeset_id: draft.changeset_id });
      expect(pv.data.placeholder_files_removed).toContain('index.html');
      const home = await get(new URL(pv.data.preview_url).pathname);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain('Café nuevo');
      expect((await get(`${new URL(pv.data.preview_url).pathname}robots.txt`)).status).toBe(404);
      await call(c, 'discard_changeset', { changeset_id: draft.changeset_id });
      await c.close();
    }));

  it('a customised index.html is left alone, and so is the rest', () =>
    onFreshSite(async () => {
      siteFs.put('index.html.orig', '<h1>Mi copia</h1>');
      const c = await mcpClient(await connect('publish'));
      const { data: draft } = await call(c, 'start_changeset');
      await call(c, 'write_files', { changeset_id: draft.changeset_id, files: [{ path: 'index.html', content: '<h1>Café</h1>' }] });
      const pv = await call(c, 'preview_changeset', { changeset_id: draft.changeset_id });
      expect(pv.data).toMatchObject({ modified: ['index.html'], deleted: [] });
      expect(pv.data.placeholder_files_removed).toBeUndefined();
      expect((await call(c, 'publish', { changeset_id: draft.changeset_id })).isError).toBe(false);
      expect([...siteFs.files.keys()].sort()).toEqual(['crservers-logo.svg', 'index.html', 'index.html.orig', 'robots.txt']);
      expect(siteFs.text('index.html.orig')).toBe('<h1>Mi copia</h1>');
      await c.close();
    }));
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
  it('is opt-in only: big changes alone never need it', () => {
    const big = { added: Array.from({ length: 30 }, (_, i) => `p${i}.html`), modified: ['index.html'], deleted: ['old.png'] };
    expect(approvalReasons(big, { approveEveryPublish: false })).toEqual([]);
    expect(approvalReasons({ added: ['a.html'], modified: [], deleted: [] }, { approveEveryPublish: true })).toEqual(['always']);
  });

  const setOptIn = (on: boolean) => pool.query('UPDATE sites SET approve_every_publish = $1 WHERE service_id = 15', [on]);
  beforeAll(() => setOptIn(true));
  afterAll(() => setOptIn(false));

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
    expect(pub.data).toMatchObject({ needs_approval: true, reasons: ['always'] });
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
    expect(html).toContain('Usted pidió aprobar cada publicación.');
    expect(html).toContain('src="/assets/crservers-logo.svg"');
    expect(html).toMatch(/href="http:\/\/localhost:\d+\/p\/[A-Za-z0-9_-]{32}\/"/);

    const post = (headers: Record<string, string>) =>
      fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: 'decision=approve' });
    expect((await post({ cookie: session!, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ origin: base })).status).toBe(403); // no session
    expect((await post({ cookie: session!, origin: 'null' })).status).toBe(403); // opaque origin, no fetch metadata
    // Browsers may send "Origin: null" on form posts; Sec-Fetch-Site still says it's our own page.
    const ok = await post({ cookie: session!, origin: 'null', 'sec-fetch-site': 'same-origin' });
    expect(ok.status).toBe(303);
    expect(siteFs.text('index.html')).toBe('<h1>Inicio nuevo</h1>');
    expect(await (await get(path, { cookie: session! })).text()).toContain('Publicado');

    const after = await call(c, 'publish', { changeset_id: id });
    expect(after.data).toMatchObject({ approved_in_browser: true, release: expect.any(Number) });
    const log = await call(c, 'get_activity_log', { limit: 3 });
    expect(log.data.events[0]).toMatchObject({ action: 'publish', approved_in_browser: true, files_changed: 1 });
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

describe('without the opt-in', () => {
  it('a home page change publishes straight from the chat', async () => {
    const c = await mcpClient(await connect('publish'));
    const { data: draft } = await call(c, 'start_changeset');
    await call(c, 'write_files', { changeset_id: draft.changeset_id, files: [{ path: 'index.html', content: '<h1>directo</h1>' }] });
    await call(c, 'preview_changeset', { changeset_id: draft.changeset_id });
    const pub = await call(c, 'publish', { changeset_id: draft.changeset_id });
    expect(pub.data.needs_approval).toBeUndefined();
    expect(siteFs.text('index.html')).toBe('<h1>directo</h1>');
    await call(c, 'revert_release', { release: pub.data.release });
    await c.close();
  });

  it('serves an app icon any site can load (directory listings)', async () => {
    for (const path of ['/icon.png', '/favicon.ico']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');
    }
  });

  it('serves its own logo', async () => {
    const res = await get('/assets/crservers-logo.svg');
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    expect(await res.text()).toMatch(/^<svg /);
  });
});

describe('import_from_url', () => {
  it('brings a media file into the draft, and refuses pages pretending to be images', async () => {
    const c = await mcpClient(await connect('publish'));
    const { data: draft } = await call(c, 'start_changeset');
    const good = await call(c, 'import_from_url', { changeset_id: draft.changeset_id, url: 'https://images.example/foto.png', path: 'img/foto.png' });
    expect(good.isError).toBe(false);
    expect(good.data).toMatchObject({ path: 'img/foto.png', size: 11 });
    const bad = await call(c, 'import_from_url', { changeset_id: draft.changeset_id, url: 'https://drive.example/share', path: 'img/otra.png' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('not a .png');
    const text = await call(c, 'import_from_url', { changeset_id: draft.changeset_id, url: 'https://x.example/a', path: 'pagina.html' });
    expect(text.isError).toBe(true);
    const pv = await call(c, 'preview_changeset', { changeset_id: draft.changeset_id });
    expect(pv.data.added).toEqual(['img/foto.png']);
    await call(c, 'discard_changeset', { changeset_id: draft.changeset_id });
    await c.close();
  });
});

describe('client area exchange errors', () => {
  it('logs the client area reason without the code or key', async () => {
    const { ClientAreaClient } = await import('../src/auth/clientarea.js');
    const logs: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => logs.push(m);
    try {
      const fake = (async () => new Response(JSON.stringify({ error: ['Your IP is not permitted to use this API ID / KEY'], info: [] }), { status: 200 })) as unknown as typeof fetch;
      const r = await new ClientAreaClient('https://ca.example', 'id', 'sekret-key', fake).exchange('the-code', 'the-rid');
      expect(r).toBeNull();
    } finally {
      console.warn = orig;
    }
    expect(logs.join('\n')).toContain('Your IP is not permitted');
    expect(logs.join('\n')).not.toMatch(/sekret-key|the-code/);
  });
});

import { createCipheriv, createHmac } from 'node:crypto';
import { siteSetupKey } from '../src/auth/sitesetup.js';

/** What the plugin's sealForConnector() produces. */
function sealSetup(creds: Record<string, string>): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', siteSetupKey(reqKey), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(creds)), c.final()]);
  return ['v1', iv.toString('base64url'), ct.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
}

/** What the plugin's notifyConnector() sends. */
async function sendEvent(serviceId: number, event: string, opts: { key?: Buffer; at?: number; nonce?: string } = {}) {
  const body = JSON.stringify({ service_id: serviceId, event, at: opts.at ?? Math.floor(Date.now() / 1000), nonce: opts.nonce ?? randomBytes(12).toString('base64url') });
  const sig = createHmac('sha256', opts.key ?? reqKey).update(body).digest('base64url');
  return fetch(`${base}/client-area/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-crs-signature': sig }, body });
}

async function connectWith(grant: ClientAreaGrant): Promise<{ token: string | null; error: string | null }> {
  const clientId = (sharedClientId ??= await register());
  const { cookie, verifier, payload } = await startAuthorize(clientId);
  const code = `ca-setup-${payload.rid}`;
  caResults.set(code, grant);
  const back = new URL((await get(`/oauth/callback?code=${code}&rid=${payload.rid}`, { cookie })).headers.get('location')!);
  if (back.searchParams.get('error')) return { token: null, error: back.searchParams.get('error_description') };
  const tok = await form('/token', { grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, client_id: clientId });
  return { token: ((await tok.json()) as { access_token: string }).access_token, error: null };
}

describe('automatic site setup', () => {
  // Generated: no credential-like literals in the repo.
  const creds = { ftp_host: 'iwx41.crservers.com', ftp_user: 'crsconnect@nuevo.example', ftp_password: randomBytes(24).toString('base64url') };

  it('a site the connector has never seen is registered on its first connection', async () => {
    expect(await sitesRepo.byAccount(77)).toBeUndefined();
    const before = await connectWith({ client_id: 30, account_id: 77, domain: 'nuevo.example', server_id: '6', scope: 'publish' });
    expect(before.error).toBe('site not enabled for AI publishing yet'); // no setup → still refused

    const { token } = await connectWith({ client_id: 30, account_id: 77, domain: 'nuevo.example', server_id: '6', scope: 'publish', site_setup: sealSetup(creds) });
    expect(token).toBeTruthy();
    const site = (await sitesRepo.byAccount(77))!;
    expect(site).toMatchObject({ domain: 'nuevo.example', status: 'active' });
    expect(await sitesRepo.ftpConfig(site.id)).toMatchObject({ host: 'iwx41.crservers.com', user: 'crsconnect@nuevo.example', password: creds.ftp_password, secure: true });
    expect((await siteInfo(token!)).body).toMatchObject({ domain: 'nuevo.example' });
  });

  it('replaces credentials when the client area resets the deploy user; ignores tampered setups', async () => {
    const reset = { ...creds, ftp_password: randomBytes(24).toString('base64url') };
    await connectWith({ client_id: 30, account_id: 77, domain: 'nuevo.example', server_id: '6', scope: 'publish', site_setup: sealSetup(reset) });
    const site = (await sitesRepo.byAccount(77))!;
    expect((await sitesRepo.ftpConfig(site.id)).password).toBe(reset.ftp_password);

    const forged = sealSetup(creds).replace(/\.[^.]+$/, '.AAAAAAAAAAAAAAAAAAAAAA');
    const r = await connectWith({ client_id: 31, account_id: 78, domain: 'otro.example', server_id: '6', scope: 'publish', site_setup: forged });
    expect(r.error).toBe('site not enabled for AI publishing yet');
    expect(await sitesRepo.byAccount(78)).toBeUndefined();
  });

  it('lifecycle events: suspend pauses, unsuspend resumes, terminate revokes; only signed and fresh', async () => {
    const { token } = await connectWith({ client_id: 30, account_id: 77, domain: 'nuevo.example', server_id: '6', scope: 'publish' });
    expect((await sendEvent(77, 'suspend', { key: randomBytes(32) })).status).toBe(401);
    expect((await sendEvent(77, 'suspend', { at: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect(((await (await sendEvent(77, 'teleport')).json()) as { ok: boolean }).ok).toBe(false);

    const nonce = randomBytes(12).toString('base64url');
    expect((await sendEvent(77, 'suspend', { nonce })).status).toBe(200);
    expect(await (await sendEvent(77, 'suspend', { nonce })).json()).toMatchObject({ replay: true });
    expect((await sitesRepo.byAccount(77))!.status).toBe('frozen');
    const c = await mcpClient(token!);
    expect((await call(c, 'get_site_info')).text).toContain('pausada');
    expect((await connectWith({ client_id: 30, account_id: 77, domain: 'nuevo.example', server_id: '6', scope: 'publish' })).error).toBeTruthy();

    await sendEvent(77, 'unsuspend');
    expect((await call(c, 'get_site_info')).data).toMatchObject({ domain: 'nuevo.example' });

    await sendEvent(77, 'terminate');
    expect((await siteInfo(token!)).status).toBe(401);
    expect((await sitesRepo.byAccount(77))!.status).toBe('frozen');
    await c.close();
  });

  it('ownership change revokes connections but leaves the site active', async () => {
    await sendEvent(77, 'unsuspend');
    const { token } = await connectWith({ client_id: 30, account_id: 77, domain: 'nuevo.example', server_id: '6', scope: 'publish' });
    expect((await siteInfo(token!)).status).toBe(200);
    expect((await sendEvent(77, 'revoke')).status).toBe(200);
    expect((await siteInfo(token!)).status).toBe(401);
    expect((await sitesRepo.byAccount(77))!.status).toBe('active');
    expect((await sendEvent(999999, 'suspend')).status).toBe(200); // unknown service: accepted, ignored
  });
});

describe('client-area API for the AI Connect page', () => {
  /** What the plugin's crsApi() sends. */
  async function api(path: string, payload: Record<string, unknown>, opts: { key?: Buffer; nonce?: string } = {}) {
    const body = JSON.stringify({ ...payload, at: Math.floor(Date.now() / 1000), nonce: opts.nonce ?? randomBytes(12).toString('base64url') });
    const sig = createHmac('sha256', opts.key ?? reqKey).update(body).digest('base64url');
    const res = await fetch(`${base}/client-area/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-crs-signature': sig }, body });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  it('lists connections and activity; revokes one; toggles approval; only signed, single-use requests', async () => {
    const token = await connect('publish');
    const grantId = (await pool.query(`SELECT g.id FROM grants g JOIN tokens t ON t.grant_id = g.id WHERE t.token_hash = encode(sha256($1::bytea), 'hex')`, [token])).rows[0]?.id;

    expect((await api('site', { service_id: 15 }, { key: randomBytes(32) })).status).toBe(401);
    const nonce = randomBytes(12).toString('base64url');
    const site = await api('site', { service_id: 15 }, { nonce });
    expect(site.status).toBe(200);
    expect((await api('site', { service_id: 15 }, { nonce })).status).toBe(409); // replay
    expect(site.body.site).toMatchObject({ domain: 'uat.example', status: 'active', approve_every_publish: false });
    const mine = site.body.connections.find((c: Record<string, unknown>) => c.id === grantId);
    expect(mine).toMatchObject({ app: 'ChatGPT', permission: 'publish', connected_at: expect.any(String) });
    expect(site.body.activity.some((a: Record<string, unknown>) => a.action === 'publish' && a.app === 'ChatGPT')).toBe(true);

    expect((await api('revoke', { service_id: 15, grant_id: grantId })).body).toMatchObject({ ok: true, revoked: 1 });
    expect((await siteInfo(token)).status).toBe(401);
    expect((await api('revoke', { service_id: 77777, grant_id: 'all' })).status).toBe(404);

    expect((await api('settings', { service_id: 15, approve_every_publish: true })).body).toMatchObject({ approve_every_publish: true });
    expect((await sitesRepo.byAccount(15))!.approveEveryPublish).toBe(true);
    await api('settings', { service_id: 15, approve_every_publish: false });
    const after = await api('site', { service_id: 15 });
    expect(after.body.site.approve_every_publish).toBe(false);
    expect(after.body.activity.slice(0, 3).map((a: Record<string, unknown>) => a.action)).toEqual(['settings_changed', 'settings_changed', 'connection_revoked']);
    expect(after.body.activity[0].app).toBe('owner');

    expect((await api('site', { service_id: 424242 })).body).toMatchObject({ ok: true, site: null, connections: [] });
  });

  it('revoke "all" ends every connection to the site', async () => {
    const a = await connect('publish');
    const b = await connect('preview');
    const r = await api('revoke', { service_id: 15, grant_id: 'all' });
    expect(r.body.revoked).toBeGreaterThanOrEqual(2);
    expect((await siteInfo(a)).status).toBe(401);
    expect((await siteInfo(b)).status).toBe(401);
  });
});

describe('several sites per hosting service and per connection', () => {
  // A hosting service (88) with its main domain, a secondary domain and a subdomain (inside the main site's folder).
  const setup = (user: string) => sealSetup({ ftp_host: 'iwx41.crservers.com', ftp_user: user, ftp_password: randomBytes(24).toString('base64url') });
  const multi = (sites: NonNullable<ClientAreaGrant['sites']>, scope: 'publish' | 'preview' = 'publish'): ClientAreaGrant => ({
    client_id: 40, account_id: sites[0]!.account_id, domain: sites[0]!.domain, server_id: '6', scope, sites,
  });
  const MAIN = { account_id: 88, domain: 'selva.example', kind: 'main' as const, protected_dirs: ['dev'] };
  const SECOND = { account_id: 88, domain: 'carrot.example', kind: 'secondary' as const, protected_dirs: [] };
  const SUB = { account_id: 88, domain: 'dev.selva.example', kind: 'subdomain' as const, protected_dirs: [] };
  async function api(path: string, payload: Record<string, unknown>) {
    const body = JSON.stringify({ ...payload, at: Math.floor(Date.now() / 1000), nonce: randomBytes(12).toString('base64url') });
    const sig = createHmac('sha256', reqKey).update(body).digest('base64url');
    const res = await fetch(`${base}/client-area/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-crs-signature': sig }, body });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }
  let token: string;

  it('one connection covers every chosen site; each gets its own deploy user on first use', async () => {
    const r = await connectWith(multi([
      { ...MAIN, site_setup: setup('crsconnect@selva.example') },
      { ...SECOND, site_setup: setup('crsconnect1a2b3c4d@selva.example') },
      { ...SUB, site_setup: setup('crsconnect9f8e7d6c@selva.example') },
    ]));
    expect(r.error).toBeNull();
    token = r.token!;
    expect((await sitesRepo.byService(88)).map((x) => [x.domain, x.kind])).toEqual([
      ['selva.example', 'main'], ['carrot.example', 'secondary'], ['dev.selva.example', 'subdomain'],
    ]);
    expect((await sitesRepo.ftpConfig((await sitesRepo.byAccount(88, 'carrot.example'))!.id)).user).toBe('crsconnect1a2b3c4d@selva.example');
    expect((await sitesRepo.byAccount(88))!.domain).toBe('selva.example'); // no domain: the main one

    const c = await mcpClient(token);
    expect((await call(c, 'list_sites')).data.sites.map((x: Structured) => x.domain)).toEqual(['carrot.example', 'dev.selva.example', 'selva.example']);
    await c.close();
  });

  it('tools ask which site when there are several; drafts carry their site', async () => {
    const c = await mcpClient(token);
    const ambiguous = await call(c, 'get_site_info');
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.data.sites).toEqual(['carrot.example', 'dev.selva.example', 'selva.example']);
    expect((await call(c, 'get_site_info', { site: 'https://www.carrot.example/' })).data).toMatchObject({ domain: 'carrot.example', type: 'secondary' });
    expect((await call(c, 'get_site_info', { site: 'nope.example' })).isError).toBe(true);

    const { data: d } = await call(c, 'start_changeset', { site: 'dev.selva.example' });
    expect(d.site).toBe('dev.selva.example');
    expect((await call(c, 'write_files', { changeset_id: d.changeset_id, files: [{ path: 'index.html', content: '<h1>dev</h1>' }] })).isError).toBe(false);
    expect((await call(c, 'preview_changeset', { changeset_id: d.changeset_id })).isError).toBe(false);
    expect((await call(c, 'list_releases', { site: 'dev.selva.example' })).data.releases).toEqual([]);
    await c.close();
  });

  it('the parent site can read a subdomain folder but not change it', async () => {
    const c = await mcpClient(token);
    expect((await call(c, 'get_site_info', { site: 'selva.example' })).data.other_site_folders).toEqual(['dev']);
    const { data: d } = await call(c, 'start_changeset', { site: 'selva.example' });
    for (const [tool, args] of [
      ['write_files', { files: [{ path: 'dev/index.html', content: 'x' }] }],
      ['edit_file', { path: 'dev/index.html', edits: [{ old_text: 'a', new_text: 'b' }] }],
      ['delete_files', { paths: ['./dev/old.html'] }],
      ['import_from_url', { url: 'https://img.example/foto.png', path: 'dev/foto.png' }],
    ] as const) {
      const r = await call(c, tool, { changeset_id: d.changeset_id, ...args });
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toContain('dev/');
    }
    expect((await call(c, 'write_files', { changeset_id: d.changeset_id, files: [{ path: 'developers.html', content: 'ok' }] })).isError).toBe(false);
    await c.close();
  });

  it('a subdomain created after connecting is protected without reconnecting', async () => {
    const c = await mcpClient(token);
    // Drafted while "shop" was still an ordinary folder of selva.example.
    const { data: d } = await call(c, 'start_changeset', { site: 'selva.example' });
    expect((await call(c, 'write_files', { changeset_id: d.changeset_id, files: [{ path: 'shop/index.html', content: 'tienda' }] })).isError).toBe(false);
    expect((await call(c, 'preview_changeset', { changeset_id: d.changeset_id })).isError).toBe(false);

    // The client then creates shop.selva.example in the panel: its folder is inside selva.example.
    layouts.set(88, [
      { domain: 'selva.example', kind: 'main', protected_dirs: ['dev', 'shop'] },
      { domain: 'carrot.example', kind: 'secondary', protected_dirs: [] },
      { domain: 'dev.selva.example', kind: 'subdomain', protected_dirs: [] },
      { domain: 'shop.selva.example', kind: 'subdomain', protected_dirs: [] },
    ]);
    const pub = await call(c, 'publish', { changeset_id: d.changeset_id });
    expect(pub.isError).toBe(true);
    expect(pub.text).toContain('shop/');
    expect(siteFs.files.has('shop/index.html')).toBe(false);
    expect((await sitesRepo.byAccount(88))!.protectedDirs).toEqual(['dev', 'shop']);
    expect((await call(c, 'get_site_info', { site: 'selva.example' })).data.other_site_folders).toEqual(['dev', 'shop']);

    // New drafts can't touch it either.
    const { data: d2 } = await call(c, 'start_changeset', { site: 'selva.example' });
    expect((await call(c, 'write_files', { changeset_id: d2.changeset_id, files: [{ path: 'shop/x.html', content: 'x' }] })).isError).toBe(true);

    // If the client area can't confirm the layout, nothing is published; drafting still works.
    layouts.set(88, 'down');
    expect((await call(c, 'write_files', { changeset_id: d2.changeset_id, files: [{ path: 'nosotros.html', content: 'ok' }] })).isError).toBe(false);
    expect((await call(c, 'preview_changeset', { changeset_id: d2.changeset_id })).isError).toBe(false);
    const down = await call(c, 'publish', { changeset_id: d2.changeset_id });
    expect(down.isError).toBe(true);
    expect(down.text).toContain('Could not confirm the hosting layout');
    expect(siteFs.files.has('nosotros.html')).toBe(false);
    layouts.delete(88);
    await c.close();
  });

  it('removing access for one site keeps the connection for the others', async () => {
    const page = await api('site', { service_id: 88, domain: 'carrot.example' });
    expect(page.body.site).toMatchObject({ domain: 'carrot.example', kind: 'secondary' });
    const conn = page.body.connections[0];
    expect(conn.other_sites).toEqual(['dev.selva.example', 'selva.example']);

    expect((await api('revoke', { service_id: 88, domain: 'carrot.example', grant_id: conn.id })).body.revoked).toBe(1);
    const c = await mcpClient(token);
    expect((await call(c, 'list_sites')).data.sites.map((x: Structured) => x.domain)).toEqual(['dev.selva.example', 'selva.example']);
    expect((await call(c, 'get_site_info', { site: 'carrot.example' })).isError).toBe(true);
    await c.close();

    expect((await api('settings', { service_id: 88, domain: 'dev.selva.example', approve_every_publish: true })).body.approve_every_publish).toBe(true);
    expect((await sitesRepo.byAccount(88, 'dev.selva.example'))!.approveEveryPublish).toBe(true);
    expect((await sitesRepo.byAccount(88))!.approveEveryPublish).toBe(false);
  });

  it('lifecycle events apply to every site of the service; ownership change ends the connection', async () => {
    await sendEvent(88, 'suspend');
    expect((await sitesRepo.byService(88)).every((x) => x.status === 'frozen')).toBe(true);
    const c = await mcpClient(token);
    expect((await call(c, 'list_sites')).data.sites.every((x: Structured) => x.status === 'paused')).toBe(true);
    expect((await call(c, 'get_site_info', { site: 'selva.example' })).text).toContain('pausada');
    await c.close();
    await sendEvent(88, 'unsuspend');
    expect((await sitesRepo.byService(88)).every((x) => x.status === 'active')).toBe(true);

    await sendEvent(88, 'revoke');
    expect((await siteInfo(token)).status).toBe(401);
  });

  it('a connection mixing two hosting services loses only the transferred one', async () => {
    const r = await connectWith(multi([{ ...MAIN }, { account_id: 15, domain: 'uat.example', kind: 'main', protected_dirs: [] }]));
    expect(r.error).toBeNull();
    await sendEvent(88, 'revoke');
    const c = await mcpClient(r.token!);
    expect((await call(c, 'list_sites')).data.sites.map((x: Structured) => x.domain)).toEqual(['uat.example']);
    await c.close();
  });

  it('refuses the whole connection when a chosen site is not set up', async () => {
    const r = await connectWith(multi([{ ...MAIN }, { account_id: 88, domain: 'nuevo2.example', kind: 'secondary', protected_dirs: [] }]));
    expect(r.error).toBe('site not enabled for AI publishing yet');
  });
});

describe('ChatGPT directory readiness', () => {
  it('add_attachments declares OpenAI file params with the exact schema the review scan expects', async () => {
    const c = await mcpClient(await connect('publish'));
    const { tools } = await c.listTools();
    const t = tools.find((x) => x.name === 'add_attachments')!;
    expect(t._meta).toMatchObject({ 'openai/fileParams': ['files'] });
    const file = (t.inputSchema.properties as any).files.items;
    expect(Object.keys(file.properties).sort()).toEqual(['download_url', 'file_id', 'file_name', 'mime_type']);
    expect([...file.required].sort()).toEqual(['download_url', 'file_id']);
    for (const x of tools) expect(x.annotations, x.name).toMatchObject({ readOnlyHint: expect.any(Boolean), destructiveHint: expect.any(Boolean), openWorldHint: expect.any(Boolean) });
    await c.close();
  });

  it('adds attached photos to the draft; refuses a mismatch; requires one path per file', async () => {
    const c = await mcpClient(await connect('publish'));
    const { data: draft } = await call(c, 'start_changeset');
    const photo = { download_url: 'https://files.oaiusercontent.example/foto.png', file_id: 'file_1', mime_type: 'image/png', file_name: 'IMG_0001.png' };
    const ok = await call(c, 'add_attachments', { changeset_id: draft.changeset_id, files: [photo], paths: ['img/equipo.png'] });
    expect(ok.isError).toBe(false);
    expect(ok.data.added).toEqual([{ path: 'img/equipo.png', size: 11 }]);
    const html = { download_url: 'https://files.oaiusercontent.example/page', file_id: 'file_2' };
    const bad = await call(c, 'add_attachments', { changeset_id: draft.changeset_id, files: [html], paths: ['img/x.png'] });
    expect(bad.isError).toBe(true);
    const mismatch = await call(c, 'add_attachments', { changeset_id: draft.changeset_id, files: [photo, photo], paths: ['img/a.png'] });
    expect(mismatch.isError).toBe(true);
    await call(c, 'discard_changeset', { changeset_id: draft.changeset_id });
    await c.close();
  });

  it('tool output carries no internal ids', async () => {
    const c = await mcpClient(await connect('publish'));
    expect((await call(c, 'list_sites')).data.sites[0]).toEqual({ domain: 'uat.example', type: 'main', permission: 'publish', status: 'active' });
    const log = await call(c, 'get_activity_log', { limit: 50 });
    const text = JSON.stringify(log.data);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); // no UUIDs
    expect(text).not.toContain('changeset_id');
    await c.close();
  });

  it('serves the OpenAI domain verification token as plain text', async () => {
    const res = await get('/.well-known/openai-apps-challenge');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('test-challenge-token');
  });
});

describe('edit_file removals', () => {
  it('removes text with an empty or omitted replacement', async () => {
    siteFs.put('quitar.html', '<h1>Hola</h1><h2>hello leister hello helbertson</h2><p>fin</p>');
    const c = await mcpClient(await connect('publish'));
    const { data: draft } = await call(c, 'start_changeset');
    const empty = await call(c, 'edit_file', { changeset_id: draft.changeset_id, path: 'quitar.html', edits: [{ old_text: '<h2>hello leister hello helbertson</h2>', new_text: '' }] });
    expect(empty.isError).toBe(false);
    expect((await call(c, 'read_file', { path: 'quitar.html', changeset_id: draft.changeset_id })).data.text).toBe('<h1>Hola</h1><p>fin</p>');
    const omitted = await call(c, 'edit_file', { changeset_id: draft.changeset_id, path: 'quitar.html', edits: [{ old_text: '<p>fin</p>' }] });
    expect(omitted.isError).toBe(false);
    expect((await call(c, 'read_file', { path: 'quitar.html', changeset_id: draft.changeset_id })).data.text).toBe('<h1>Hola</h1>');
    // The tool-call log line sees each call's outcome.
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: string) => logs.push(m);
    try {
      await call(c, 'edit_file', { changeset_id: draft.changeset_id, path: 'quitar.html', edits: [{ old_text: 'no existe' }] });
      await call(c, 'list_sites');
    } finally {
      console.log = orig;
    }
    const lines = logs.filter((l) => l.includes('"tool_call"')).map((l) => JSON.parse(l));
    expect(lines).toEqual([
      expect.objectContaining({ tool: 'edit_file', ok: false, error: expect.stringContaining('0') }),
      expect.objectContaining({ tool: 'list_sites', ok: true }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('quitar.html');
    await call(c, 'discard_changeset', { changeset_id: draft.changeset_id });
    await c.close();
  });
});

describe('support correlation (#56)', () => {
  it('shows a ref in errors; logs carry only the ref, support records carry site/service/client/app', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: string) => logs.push(m);
    let failed: Awaited<ReturnType<typeof call>>;
    const since = new Date();
    try {
      const c = await mcpClient(await connect('publish'));
      failed = await call(c, 'list_files', { path: 'no-existe-56' });
      await call(c, 'get_site_info');
      await c.close();
    } finally {
      console.log = orig;
    }
    const ref = /\(ref: ([A-Z2-9]{6})\)/.exec(failed.text)?.[1];
    expect(ref).toBeTruthy();
    expect(failed.text).toContain('Folder not found');

    // Request logs: the ref, the app name, and no ids or paths.
    const events = logs.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    expect(events.find((e) => e.event === 'mcp_initialize')).toMatchObject({ app: expect.any(String) });
    const calls = events.filter((e) => e.event === 'tool_call');
    expect(calls).toEqual([expect.objectContaining({ tool: 'list_files', ok: false, ref }), expect.objectContaining({ tool: 'get_site_info', ok: true })]);
    const text = JSON.stringify(events);
    for (const banned of ['no-existe-56', '"site"', '"service"', '"client"', '"sites"']) expect(text).not.toContain(banned);

    // Support records (written in the background): the link to site, service, client and app.
    type Row = { kind: string; ref: string | null; tool: string | null; ok: boolean | null; site_ids: string[]; service_id: number | null; client_id: string | null; app: string | null };
    let rows: Row[] = [];
    for (let i = 0; i < 50 && rows.length < 3; i++) {
      rows = (await pool.query<Row>('SELECT kind, ref, tool, ok, site_ids, service_id, client_id, app FROM support_events WHERE at >= $1 ORDER BY id', [since])).rows;
      if (rows.length < 3) await new Promise((r) => setTimeout(r, 20));
    }
    const init = rows.find((r) => r.kind === 'initialize');
    const bad = rows.find((r) => r.ref === ref);
    expect(init).toMatchObject({ app: expect.any(String), client_id: expect.any(String) });
    expect(init!.site_ids.length).toBe(1);
    expect(bad).toMatchObject({ kind: 'tool_call', tool: 'list_files', ok: false, site_ids: init!.site_ids, service_id: expect.any(Number), client_id: init!.client_id });
    expect(rows.find((r) => r.tool === 'get_site_info')).toMatchObject({ ok: true, ref: null, service_id: bad!.service_id });
  });
});

describe('2026-07-28 clients (ChatGPT: server/discover, no initialize)', () => {
  it('connect, call tools and get support records with the same token and grant', async () => {
    const token = await connect('publish');
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: string) => logs.push(m);
    const since = new Date();
    let failed = '';
    let info: Structured = {};
    let version: string | undefined;
    try {
      const c = new ClientV2({ name: 'openai-mcp', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await c.connect(new HttpV2(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      version = c.getNegotiatedProtocolVersion();
      info = (await c.callTool({ name: 'get_site_info', arguments: {} })).structuredContent as Structured;
      failed = ((await c.callTool({ name: 'list_files', arguments: { path: 'no-existe-2026' } })).content as { text: string }[])[0]!.text;
      await c.close();
    } finally {
      console.log = orig;
    }
    expect(version).toBe('2026-07-28');
    expect(info).toMatchObject({ domain: 'uat.example' });
    const ref = /\(ref: ([A-Z2-9]{6})\)/.exec(failed)?.[1];
    expect(ref).toBeTruthy();

    const events = logs.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    expect(events.find((e) => e.event === 'mcp_initialize')).toMatchObject({ app: 'openai-mcp', app_version: '1.0.0', via: 'server/discover' });
    expect(events.filter((e) => e.event === 'tool_call')).toEqual([expect.objectContaining({ tool: 'get_site_info', ok: true }), expect.objectContaining({ tool: 'list_files', ok: false, ref })]);

    type Row = { kind: string; ref: string | null; app: string | null; service_id: number | null; site_ids: string[] };
    let rows: Row[] = [];
    for (let i = 0; i < 50 && rows.length < 3; i++) {
      rows = (await pool.query<Row>('SELECT kind, ref, app, service_id, site_ids FROM support_events WHERE at >= $1 ORDER BY id', [since])).rows;
      if (rows.length < 3) await new Promise((r) => setTimeout(r, 20));
    }
    expect(rows.find((r) => r.kind === 'initialize')).toMatchObject({ app: 'openai-mcp' });
    expect(rows.find((r) => r.ref === ref)).toMatchObject({ kind: 'tool_call', service_id: expect.any(Number), site_ids: [expect.any(String)] });
  });
});

describe('site guide (.htcrservers-guide.md)', () => {
  it('the assistant saves a rule to the guide and every later draft returns it', async () => {
    try {
      const c = await mcpClient(await connect('publish'));
      const before = await call(c, 'get_site_info');
      expect(before.data.site_guide).toMatchObject({ path: '.htcrservers-guide.md', text: null });
      expect(before.text).toContain('no guide yet');
      const d = await call(c, 'start_changeset');
      const w = await call(c, 'write_files', { changeset_id: d.data.changeset_id, files: [{ path: '.htcrservers-guide.md', content: '# Guía\n- Los eventos nuevos van arriba.' }] });
      expect(w.data.results[0]).toMatchObject({ ok: true });
      await call(c, 'preview_changeset', { changeset_id: d.data.changeset_id });
      await call(c, 'publish', { changeset_id: d.data.changeset_id });
      expect(siteFs.text('.htcrservers-guide.md')).toContain('eventos nuevos van arriba');

      const next = await call(c, 'start_changeset');
      expect(next.text).toContain('follow it for every change');
      expect(next.data.site_guide.text).toBe('# Guía\n- Los eventos nuevos van arriba.');
      expect(next.data.site_guide.updated_at).toBeNull(); // MemorySiteFs times aren't MLSD
      const e = await call(c, 'edit_file', { changeset_id: next.data.changeset_id, path: '.htcrservers-guide.md', edits: [{ old_text: 'arriba.', new_text: 'arriba.\n- Tono cercano, de usted.' }] });
      expect(e.text).toContain('1 cambio');
      expect((await call(c, 'read_file', { path: '.htcrservers-guide.md', changeset_id: next.data.changeset_id })).data.text).toContain('Tono cercano');
      const big = await call(c, 'write_files', { changeset_id: next.data.changeset_id, files: [{ path: '.htcrservers-guide.md', content: 'a'.repeat(17_000) }] });
      expect(JSON.stringify(big.data)).toContain('16 KB');
      const other = await call(c, 'write_files', { changeset_id: next.data.changeset_id, files: [{ path: '.htaccess', content: 'x' }] });
      expect(JSON.stringify(other.data)).toContain('Hidden files');
      await call(c, 'discard_changeset', { changeset_id: next.data.changeset_id });
      expect((await call(c, 'get_site_info')).data.site_guide.text).toContain('eventos nuevos');
      await c.close();
    } finally {
      siteFs.files.delete('.htcrservers-guide.md');
    }
  });
});

describe('managed contact form', () => {
  it('get_site_info and start_changeset tell the AI how to call /contact.php when the form is installed', async () => {
    const marker = { tool: 'crservers-components', components: { contact_form: { version: '2.1.0', endpoint: '/contact.php' } } };
    await siteFs.write('.htcrservers-components.json', Buffer.from(JSON.stringify(marker)));
    await siteFs.write('contact.php', Buffer.from('<?php'));
    try {
      const c = await mcpClient(await connect('publish'));
      const info = await call(c, 'get_site_info');
      expect(info.text).toContain('contact form');
      expect(info.data.managed_components.contact_form).toMatchObject({ enabled: true, version: '2.1.0', endpoint: '/contact.php', method: 'POST' });
      const d = await call(c, 'start_changeset');
      expect(d.data.managed_components.contact_form.guidance).toContain('posts to /contact.php');
      const w = await call(c, 'write_files', { changeset_id: d.data.changeset_id, files: [{ path: 'contact.php', content: '<?php mail();' }] });
      expect(JSON.stringify(w.data)).toContain('installs and maintains');
      await call(c, 'discard_changeset', { changeset_id: d.data.changeset_id });
      await c.close();
    } finally {
      siteFs.files.delete('.htcrservers-components.json');
      siteFs.files.delete('contact.php');
    }
  });

  it('a site without the form gets no managed_components', async () => {
    const c = await mcpClient(await connect('publish'));
    expect((await call(c, 'get_site_info')).data).not.toHaveProperty('managed_components');
    await c.close();
  });
});

describe('sites published from GitHub (CR Servers Deploy marker)', () => {
  it('get_site_info, start_changeset and publish say the next deploy replaces changes made here', async () => {
    await siteFs.write('.htcrservers-deploy.json', Buffer.from(JSON.stringify({ tool: 'crservers-static-deploy', repository: 'acme/uat-site', commit: 'abcdef1234567890', deployed_at: '2026-10-16T18:00:00Z' })));
    try {
      const c = await mcpClient(await connect('publish'));
      const info = await call(c, 'get_site_info');
      expect(info.data.deployed_from_github).toMatchObject({ repository: 'acme/uat-site', repository_url: 'https://github.com/acme/uat-site', commit: 'abcdef123456' });
      expect(info.data.deployed_from_github.guidance).toContain('next deploy');
      expect(info.data.deployed_from_github).not.toHaveProperty('build');
      const d = await call(c, 'start_changeset');
      expect(d.text).toContain('https://github.com/acme/uat-site');
      expect(d.data.deployed_from_github.guidance).toContain('in the repository instead');
      await call(c, 'discard_changeset', { changeset_id: d.data.changeset_id });
      await c.close();
    } finally {
      siteFs.files.delete('.htcrservers-deploy.json');
    }
  });

  it('a Next.js export gets the compiled-site wording; a malformed marker is ignored', async () => {
    await siteFs.write('.htcrservers-deploy.json', Buffer.from(JSON.stringify({ tool: 'crservers-static-deploy', repository: 'acme/v0-site', ref: 'refs/heads/main', commit: 'abcdef1234567890' })));
    siteFs.put('_next/static/chunks/main-1a2b.js', 'x');
    try {
      const c = await mcpClient(await connect('publish'));
      const info = await call(c, 'get_site_info');
      expect(info.data.deployed_from_github).toMatchObject({ build: 'nextjs-export', deploy_branch: 'main' });
      expect(info.data.deployed_from_github.guidance).toContain('compiled Next.js static export');
      await siteFs.write('.htcrservers-deploy.json', Buffer.from('{"tool":"crservers-static-deploy","repository":"acme/v0-site"'));
      expect((await call(c, 'get_site_info')).data).not.toHaveProperty('deployed_from_github');
      await c.close();
    } finally {
      siteFs.files.delete('.htcrservers-deploy.json');
      siteFs.files.delete('_next/static/chunks/main-1a2b.js');
    }
  });

  it('a site without the marker gets no deploy guidance', async () => {
    const c = await mcpClient(await connect('publish'));
    expect((await call(c, 'get_site_info')).data).not.toHaveProperty('deployed_from_github');
    const d = await call(c, 'start_changeset');
    expect(d.text).not.toContain('GitHub');
    await call(c, 'discard_changeset', { changeset_id: d.data.changeset_id });
    await c.close();
  });
});

describe('backup files in the web root', () => {
  it('list_files flags backup-looking files with a suggestion', async () => {
    siteFs.put('index.html.bak-20260723', 'old');
    siteFs.put('index.html.orig', 'old');
    const c = await mcpClient(await connect('publish'));
    const r = await call(c, 'list_files', {});
    expect(r.data.note).toContain('index.html.bak-20260723');
    expect(r.data.note).toContain('index.html.orig');
    expect(r.data.note).not.toContain('robots');
    siteFs.files.delete('index.html.bak-20260723');
    siteFs.files.delete('index.html.orig');
    expect((await call(c, 'list_files', {})).data.note).toBeUndefined();
    await c.close();
  });
});

describe('files that may hold secrets', () => {
  it('read_file and edit_file never return the content of files that may hold secrets', async () => {
    siteFs.put('config.php', Buffer.from("<?php $db_pass = 'hunter2';"));
    try {
      const c = await mcpClient(await connect('publish'));
      const read = await call(c, 'read_file', { path: 'config.php' });
      expect(read.isError).toBe(false);
      expect(read.data).toMatchObject({ path: 'config.php', secret: true });
      expect(read.data.text).toBeUndefined();
      expect(JSON.stringify(read)).not.toContain('hunter2');
      const { data: draft } = await call(c, 'start_changeset', {});
      const edit = await call(c, 'edit_file', { changeset_id: draft.changeset_id, path: 'config.php', edits: [{ old_text: 'hunter2', new_text: 'x' }] });
      expect(edit.isError).toBe(true);
      expect(JSON.stringify(edit)).not.toContain('hunter2');
      await call(c, 'discard_changeset', { changeset_id: draft.changeset_id });
      await c.close();
    } finally {
      siteFs.files.delete('config.php');
    }
  });
});
