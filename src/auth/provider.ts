import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { hashToken, randomToken, safeEqual } from '../crypto.js';
import type { SiteRepo } from '../sites.js';
import type { ClientAreaApi, ClientAreaSite } from './clientarea.js';
import { isLoopbackRedirect, type PgClientsStore } from './clients.js';
import { signReq } from './req.js';
import { openSiteSetup } from './sitesetup.js';
import { pickLang, signInErrorPage } from '../ui/page.js';

/**
 * OAuth 2.1 authorization server for the MCP endpoint (docs/ARCHITECTURE.md, "Sign-in" and "Tokens").
 * /authorize hands the browser to the CR Servers client area for sign-in and consent;
 * /oauth/callback comes back with a one-time code, which we redeem server-to-server
 * before issuing our own code.
 */

export const BINDING_COOKIE = 'crs_bind';
const REQUEST_TTL_S = 600;
const CODE_TTL_S = 300;
const ACCESS_TTL_S = 3600;
const REFRESH_IDLE_S = 90 * 24 * 3600;

export interface ProviderDeps {
  pool: Pool;
  clients: PgClientsStore;
  sites: SiteRepo;
  clientArea: ClientAreaApi;
  issuer: string;
  mcpUrl: string;
  clientAreaUrl: string;
  reqKey: Buffer;
}

export class ConnectorOAuthProvider implements OAuthServerProvider {
  constructor(private readonly d: ProviderDeps) {}

  get clientsStore() {
    return this.d.clients;
  }

  private checkResource(resource?: URL): void {
    if (resource && resource.href.replace(/\/+$/, '') !== this.d.mcpUrl) {
      throw new InvalidTargetError('This authorization server only issues tokens for its own MCP endpoint');
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const rid = randomToken(24);
    const binding = randomToken(32);
    await this.d.pool.query(
      `INSERT INTO auth_requests (rid, client_id, redirect_uri, code_challenge, state, scopes, resource, binding_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))`,
      [rid, client.client_id, params.redirectUri, params.codeChallenge, params.state ?? null, params.scopes ?? [], this.d.mcpUrl, hashToken(binding), REQUEST_TTL_S],
    );
    // The consent screen names where the code goes; for a loopback or app callback (warp://…)
    // that's an app on the user's own computer.
    const redirect = new URL(params.redirectUri);
    const appHost = isLoopbackRedirect(params.redirectUri) || !/^https?:$/.test(redirect.protocol) ? 'localhost' : redirect.host;
    const req = signReq(this.d.reqKey, {
      rid,
      app_name: client.client_name?.slice(0, 60) || appHost,
      app_host: appHost,
      exp: Math.floor(Date.now() / 1000) + REQUEST_TTL_S,
    });
    // Ties the client-area round trip to this browser, so a victim can't be sent a link that
    // links their site to an attacker's AI client.
    res.cookie(BINDING_COOKIE, binding, { httpOnly: true, secure: true, sameSite: 'lax', path: '/oauth', maxAge: REQUEST_TTL_S * 1000 });
    res.redirect(302, `${this.d.clientAreaUrl}/index.php?cmd=crsconnect&req=${encodeURIComponent(req)}`);
  }

  /** GET /oauth/callback?code&rid  or  ?error=access_denied&rid */
  async clientAreaCallback(req: Request, res: Response): Promise<void> {
    const rid = typeof req.query.rid === 'string' ? req.query.rid : '';
    const binding = readCookie(req.headers.cookie, BINDING_COOKIE);
    res.clearCookie(BINDING_COOKIE, { path: '/oauth' });

    const ar = (await this.d.pool.query(
      `UPDATE auth_requests SET used_at = now() WHERE rid = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING client_id, redirect_uri, code_challenge, state, scopes, binding_hash`,
      [rid],
    )).rows[0];
    if (!ar || !binding || !safeEqual(Buffer.from(hashToken(binding)), Buffer.from(ar.binding_hash))) {
      return void res.status(400).type('html').send(signInErrorPage(pickLang(req.get('accept-language'))));
    }

    const back = new URL(ar.redirect_uri);
    if (ar.state) back.searchParams.set('state', ar.state);
    // RFC 9207: must equal the metadata `issuer` exactly (origin, no trailing slash).
    back.searchParams.set('iss', this.d.issuer.replace(/\/+$/, ''));

    if (req.query.error || typeof req.query.code !== 'string') {
      back.searchParams.set('error', 'access_denied');
      return void res.redirect(302, back.href);
    }

    const ca = await this.d.clientArea.exchange(req.query.code, rid).catch((e: Error) => {
      console.error(JSON.stringify({ t: new Date().toISOString(), event: 'client_area_exchange_failed', error: e.message.slice(0, 300) }));
      return null;
    });
    // Codes issued for approving a publish never become connections.
    if (!ca || ca.scope === 'approve') {
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('error_description', !ca ? 'sign-in could not be verified' : 'site not enabled for AI publishing yet');
      return void res.redirect(302, back.href);
    }

    // Older client areas send one site at the top level.
    const chosen: ClientAreaSite[] = ca.sites ?? [{ account_id: ca.account_id, domain: ca.domain, ...(ca.site_setup ? { site_setup: ca.site_setup } : {}) }];
    const siteIds: string[] = [];
    for (const c of chosen) {
      if (c.site_setup) {
        // First connection of this site: the client area just created its jailed deploy user.
        try {
          const s = openSiteSetup(this.d.reqKey, c.site_setup);
          await this.d.sites.upsertSetup({ serviceId: c.account_id, domain: c.domain, kind: c.kind, ftpHost: s.ftpHost, ftpUser: s.ftpUser, ftpPassword: s.ftpPassword });
          console.log(JSON.stringify({ t: new Date().toISOString(), event: 'site_setup', service_id: c.account_id, domain: c.domain }));
        } catch (e) {
          console.error(JSON.stringify({ t: new Date().toISOString(), event: 'site_setup_failed', service_id: c.account_id, domain: c.domain, error: (e as Error).message }));
        }
      }
      const site = await this.d.sites.byAccount(c.account_id, c.domain);
      if (!site || site.status !== 'active') {
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'site not enabled for AI publishing yet');
        return void res.redirect(302, back.href);
      }
      if (c.kind) await this.d.sites.setLayout(site.id, c.kind, c.protected_dirs ?? []);
      if (!siteIds.includes(site.id)) siteIds.push(site.id);
    }

    const grantId = randomUUID();
    // Always grant offline_access: ChatGPT doesn't request it, and without a refresh token every
    // connection silently dies when its 1-hour access token expires. Refresh tokens rotate, reuse
    // revokes the connection, they expire after 90 idle days, and the owner can revoke them.
    const scopes = ['site', 'offline_access'];
    await this.d.pool.query(
      `INSERT INTO grants (id, client_id, account_holder_id, site_id, permission, scopes, resource) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [grantId, ar.client_id, ca.client_id, siteIds[0], ca.scope as 'preview' | 'publish', scopes, this.d.mcpUrl],
    );
    await this.d.pool.query('INSERT INTO grant_sites (grant_id, site_id) SELECT $1, unnest($2::uuid[])', [grantId, siteIds]);
    const code = randomToken(32);
    await this.d.pool.query(
      `INSERT INTO auth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
      [hashToken(code), grantId, ar.client_id, ar.redirect_uri, ar.code_challenge, CODE_TTL_S],
    );
    back.searchParams.set('code', code);
    res.redirect(302, back.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const r = (await this.d.pool.query('SELECT code_challenge FROM auth_codes WHERE code_hash = $1 AND client_id = $2', [hashToken(code), client.client_id])).rows[0];
    if (!r) throw new InvalidGrantError('Invalid authorization code');
    return r.code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    const r = (await this.d.pool.query(
      `UPDATE auth_codes SET used_at = now()
       WHERE code_hash = $1 AND client_id = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING grant_id, redirect_uri`,
      [hashToken(code), client.client_id],
    )).rows[0];
    if (!r) throw new InvalidGrantError('Invalid or used authorization code');
    if (redirectUri && redirectUri !== r.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
    return this.issueTokens(r.grant_id, client.client_id);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    const h = hashToken(refreshToken);
    const rotated = (await this.d.pool.query(
      `UPDATE tokens SET replaced_at = now()
       WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2 AND replaced_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       RETURNING grant_id`,
      [h, client.client_id],
    )).rows[0];
    if (!rotated) {
      // Reuse of an already-rotated refresh token: assume theft, revoke the whole connection.
      const reused = (await this.d.pool.query(`SELECT grant_id FROM tokens WHERE token_hash = $1 AND kind = 'refresh' AND replaced_at IS NOT NULL`, [h])).rows[0];
      if (reused) await this.revokeGrant(reused.grant_id);
      throw new InvalidGrantError('Invalid refresh token');
    }
    return this.issueTokens(rotated.grant_id, client.client_id);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const r = (await this.d.pool.query(
      `SELECT t.client_id, t.expires_at, g.id AS grant_id, g.permission, g.scopes, g.resource, g.account_holder_id,
              ARRAY(SELECT s.site_id::text FROM grant_sites s WHERE s.grant_id = g.id) AS site_ids
       FROM tokens t JOIN grants g ON g.id = t.grant_id
       WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND g.revoked_at IS NULL AND t.expires_at > now()`,
      [hashToken(token)],
    )).rows[0];
    if (!r || r.resource !== this.d.mcpUrl) throw new InvalidTokenError('Invalid or expired token');
    return {
      token,
      clientId: r.client_id,
      scopes: r.scopes,
      expiresAt: Math.floor(new Date(r.expires_at).getTime() / 1000),
      resource: new URL(r.resource),
      extra: { grantId: r.grant_id, siteIds: r.site_ids as string[], permission: r.permission, accountHolderId: r.account_holder_id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.d.pool.query('UPDATE tokens SET revoked_at = now() WHERE token_hash = $1 AND client_id = $2 AND revoked_at IS NULL', [hashToken(request.token), client.client_id]);
  }

  /**
   * Takes a site out of every connection (service terminated or transferred, or "remove access" for
   * all apps). Connections left without sites are revoked. Returns how many connections it touched.
   */
  async revokeSite(siteId: string): Promise<number> {
    const r = await this.d.pool.query('SELECT gs.grant_id FROM grant_sites gs JOIN grants g ON g.id = gs.grant_id WHERE gs.site_id = $1 AND g.revoked_at IS NULL', [siteId]);
    for (const g of r.rows) await this.removeSite(g.grant_id, siteId);
    return r.rowCount ?? 0;
  }

  /** Takes one site out of one connection; revokes the connection when it has no sites left. */
  async removeSite(grantId: string, siteId: string): Promise<void> {
    await this.d.pool.query('DELETE FROM grant_sites WHERE grant_id = $1 AND site_id = $2', [grantId, siteId]);
    const left = (await this.d.pool.query('SELECT count(*)::int AS n FROM grant_sites WHERE grant_id = $1', [grantId])).rows[0].n as number;
    if (left === 0) await this.revokeGrant(grantId);
  }

  async revokeGrant(grantId: string): Promise<void> {
    await this.d.pool.query('UPDATE grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [grantId]);
    await this.d.pool.query('UPDATE tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL', [grantId]);
  }

  private async issueTokens(grantId: string, clientId: string): Promise<OAuthTokens> {
    const g = (await this.d.pool.query('SELECT scopes, revoked_at FROM grants WHERE id = $1', [grantId])).rows[0];
    if (!g || g.revoked_at) throw new InvalidGrantError('Connection revoked');
    const access = randomToken(32);
    await this.d.pool.query(
      `INSERT INTO tokens (token_hash, kind, grant_id, client_id, expires_at) VALUES ($1, 'access', $2, $3, now() + make_interval(secs => $4))`,
      [hashToken(access), grantId, clientId, ACCESS_TTL_S],
    );
    const tokens: OAuthTokens = { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, scope: (g.scopes as string[]).join(' ') };
    // Always (also for connections made before every grant included offline_access).
    const refresh = randomToken(32);
    await this.d.pool.query(
      `INSERT INTO tokens (token_hash, kind, grant_id, client_id, expires_at) VALUES ($1, 'refresh', $2, $3, now() + make_interval(secs => $4))`,
      [hashToken(refresh), grantId, clientId, REFRESH_IDLE_S],
    );
    tokens.refresh_token = refresh;
    return tokens;
  }
}

function readCookie(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
