import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgClientsStore } from '../src/auth/clients.js';
import type { HostbillApi, HostbillGrant } from '../src/auth/hostbill.js';
import { ConnectorOAuthProvider } from '../src/auth/provider.js';
import { verifyReq } from '../src/auth/req.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/http.js';
import { SiteRepo } from '../src/sites.js';

/**
 * Full authorization-code flow as an AI host drives it, against real Postgres and a fake
 * HostBill. Needs TEST_DATABASE_URL (CI provides one; locally: the crs-connector-pg container).
 */
const DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:54329/connector';
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const HB_URL = 'https://hostbill.test';
const reqKey = randomBytes(32);
const schema = `t_${randomBytes(6).toString('hex')}`;

let pool: pg.Pool;
let server: Server;
let base: string;
/** What /.well-known/oauth-authorization-server says, and what iss must equal. */
let issuer: string;
let provider: ConnectorOAuthProvider;
const hbResults = new Map<string, HostbillGrant | null>();
const hostbill: HostbillApi = { exchange: async (code) => hbResults.get(code) ?? null };

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
  issuer = new URL(base).href;
  const sites = new SiteRepo(pool, randomBytes(32));
  await sites.add({ hbAccountId: 15, domain: 'uat.example', ftpHost: 'iwx.test', ftpUser: 'crsconnect@uat.example', ftpPassword: 'pw' });
  provider = new ConnectorOAuthProvider({
    pool,
    clients: new PgClientsStore(pool, [CHATGPT]),
    sites,
    hostbill,
    issuer: base,
    mcpUrl,
    hostbillUrl: HB_URL,
    reqKey,
  });
  server.on('request', createApp({ provider, issuer: base, mcpUrl }));
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

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
  expect(loc.origin + loc.pathname).toBe(`${HB_URL}/index.php`);
  const req = loc.searchParams.get('req')!;
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return { req, cookie, verifier, payload: verifyReq(reqKey, req)! };
}

describe('metadata', () => {
  it('advertises iss support, CIMD and offline_access', async () => {
    const m = (await (await get('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(issuer).toBe(`${base}/`);
    expect(m).toMatchObject({ issuer, authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true, code_challenge_methods_supported: ['S256'] });
    expect(m.scopes_supported).toContain('offline_access');
    const prm = (await (await get('/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${base}/mcp`);
  });
});

describe('registration', () => {
  it('refuses redirect URIs outside the allowlist', async () => {
    const res = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
    expect(res.status).toBe(400);
  });
});

describe('authorization code flow', () => {
  it('signs a req the HostBill plugin can verify, naming the asking app', async () => {
    const { payload } = await startAuthorize(await register());
    expect(payload).toMatchObject({ app_name: 'ChatGPT', app_host: 'chatgpt.com' });
    expect(payload.rid).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('completes: HostBill code → our code (with iss) → tokens → site-scoped access', async () => {
    const clientId = await register();
    const { cookie, verifier, payload } = await startAuthorize(clientId);
    hbResults.set('hb-good', { client_id: 12, account_id: 15, domain: 'uat.example', server_id: '6', scope: 'publish' });

    const cb = await get(`/oauth/hostbill/callback?code=hb-good&rid=${payload.rid}`, { cookie });
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

    const who = await get('/mcp/whoami', { authorization: `Bearer ${t.access_token}` });
    expect(await who.json()).toMatchObject({ clientId, permission: 'publish' });

    const noAuth = await get('/mcp/whoami');
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toContain('resource_metadata=');

    // Refresh rotation, then reuse of the old refresh token revokes the whole connection.
    const r1 = await form('/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    expect(r1.status).toBe(200);
    const t2 = (await r1.json()) as { access_token: string };
    expect((await get('/mcp/whoami', { authorization: `Bearer ${t2.access_token}` })).status).toBe(200);
    const reuse = await form('/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect((await get('/mcp/whoami', { authorization: `Bearer ${t2.access_token}` })).status).toBe(401);
  });

  it('wrong PKCE verifier is refused', async () => {
    const clientId = await register();
    const { cookie, payload } = await startAuthorize(clientId);
    hbResults.set('hb-pkce', { client_id: 12, account_id: 15, domain: 'uat.example', server_id: '6', scope: 'publish' });
    const back = new URL((await get(`/oauth/hostbill/callback?code=hb-pkce&rid=${payload.rid}`, { cookie })).headers.get('location')!);
    const tok = await form('/token', { grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: pkce().verifier, client_id: clientId });
    expect(tok.status).toBe(400);
  });

  it('the callback requires the browser that started the flow', async () => {
    const { payload } = await startAuthorize(await register());
    hbResults.set('hb-x', { client_id: 12, account_id: 15, domain: 'uat.example', server_id: '6', scope: 'publish' });
    const res = await get(`/oauth/hostbill/callback?code=hb-x&rid=${payload.rid}`, { cookie: 'crs_bind=attacker' });
    expect(res.status).toBe(400);
  });

  it.each([
    ['client cancels at HostBill', 'error=access_denied', undefined],
    ['HostBill refuses the code', 'code=hb-unknown', undefined],
    ['site not enabled yet', 'code=hb-nosite', { client_id: 12, account_id: 999, domain: 'other.example', server_id: '6', scope: 'publish' as const }],
  ])('%s → access_denied back to the AI host', async (_name, query, hb) => {
    const { cookie, payload } = await startAuthorize(await register());
    if (hb) hbResults.set('hb-nosite', hb);
    const res = await get(`/oauth/hostbill/callback?${query}&rid=${payload.rid}`, { cookie });
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
