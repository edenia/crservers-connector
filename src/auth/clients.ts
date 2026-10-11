import type { Pool } from 'pg';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { randomToken } from '../crypto.js';

/**
 * OAuth clients: Dynamic Client Registration (stored) and Client ID Metadata Documents
 * (client_id is an https URL whose JSON we fetch and cache). Either way, every redirect URI
 * must be on the exact-match allowlist, so only the AI hosts we support can complete a flow.
 */

/** Hosts allowed to serve Client ID Metadata Documents (and their subdomains). */
const CIMD_HOST_SUFFIXES = ['claude.ai', 'claude.com', 'anthropic.com', 'chatgpt.com', 'openai.com'];
const CIMD_TTL_MS = 24 * 3600 * 1000;
const CIMD_MAX_BYTES = 64 * 1024;

export class PgClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly pool: Pool,
    private readonly redirectAllowlist: string[],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly cimdHostSuffixes: string[] = CIMD_HOST_SUFFIXES,
  ) {}

  private assertRedirects(uris: unknown): asserts uris is string[] {
    if (!Array.isArray(uris) || uris.length === 0) throw new InvalidClientMetadataError('redirect_uris is required');
    for (const u of uris) {
      if (typeof u !== 'string' || !this.redirectAllowlist.includes(u)) {
        throw new InvalidClientMetadataError(`redirect_uri not allowed: ${String(u)}`);
      }
    }
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = (await this.pool.query<{ info: OAuthClientInformationFull; source: string; refreshed_at: Date }>(
      'SELECT info, source, refreshed_at FROM oauth_clients WHERE client_id = $1',
      [clientId],
    )).rows[0];
    if (row && (row.source === 'dcr' || Date.now() - row.refreshed_at.getTime() < CIMD_TTL_MS)) return row.info;
    if (this.isCimdUrl(clientId)) return this.loadCimd(clientId);
    return undefined;
  }

  async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
    this.assertRedirects(client.redirect_uris);
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: `dcr_${randomToken(18)}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    await this.pool.query('INSERT INTO oauth_clients (client_id, info, source) VALUES ($1, $2, $3)', [full.client_id, full, 'dcr']);
    return full;
  }

  /** Display name for logs: client_name, else the client host, else the id. */
  async displayName(clientId: string): Promise<string> {
    const c = await this.getClient(clientId).catch(() => undefined);
    if (c?.client_name) return c.client_name;
    try {
      return new URL(clientId).hostname;
    } catch {
      return clientId;
    }
  }

  private isCimdUrl(id: string): boolean {
    let u: URL;
    try {
      u = new URL(id);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return false;
    const host = u.hostname.toLowerCase();
    return this.cimdHostSuffixes.some((s) => host === s || host.endsWith(`.${s}`));
  }

  private async loadCimd(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const res = await this.fetchImpl(clientId, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    const text = await res.text();
    if (text.length > CIMD_MAX_BYTES) return undefined;
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (doc.client_id !== clientId) return undefined;
    this.assertRedirects(doc.redirect_uris);
    const info: OAuthClientInformationFull = {
      client_id: clientId,
      redirect_uris: doc.redirect_uris,
      client_name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : undefined,
      client_uri: typeof doc.client_uri === 'string' ? doc.client_uri : undefined,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
    await this.pool.query(
      `INSERT INTO oauth_clients (client_id, info, source) VALUES ($1, $2, 'cimd')
       ON CONFLICT (client_id) DO UPDATE SET info = EXCLUDED.info, refreshed_at = now()`,
      [clientId, info],
    );
    return info;
  }
}
