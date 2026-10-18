/**
 * Server-to-server calls to the client-area extension that handles sign-in and consent:
 *   POST {CLIENT_AREA_URL}/admin/api.php  call=module&module=crsconnect&fn=exchange&code&rid
 *   POST {CLIENT_AREA_URL}/admin/api.php  call=module&module=crsconnect&fn=layout&service_id  (client area 0.7+)
 * The API key should be limited to the `module` method and IP-locked to our egress.
 */
export interface ClientAreaGrant {
  client_id: number;
  /** The first chosen site (approve: the service being approved). */
  account_id: number;
  domain: string;
  server_id: string;
  /** preview / publish: a new connection. approve: the site owner signed in to approve one publish. */
  scope: 'preview' | 'publish' | 'approve';
  /** First connection of a site: its new deploy user's credentials, sealed (see sitesetup.ts). */
  site_setup?: string;
  /** Every site the client chose for this connection (client area 0.6+; older ones send one site at the top level). */
  sites?: ClientAreaSite[];
}

/** One chosen site: a domain of a hosting service. */
export interface ClientAreaSite {
  account_id: number;
  domain: string;
  kind?: 'main' | 'secondary' | 'subdomain';
  /** Folders of this site that are other sites (subdomains), relative to its root. */
  protected_dirs?: string[];
  site_setup?: string;
}

export const MAX_SITES_PER_CONNECTION = 25;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DIR_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Validates the client area's `sites` list; throws on anything unexpected. */
export function parseSites(raw: unknown): ClientAreaSite[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SITES_PER_CONNECTION) throw new Error('Unexpected client area sites list');
  return raw.map((x) => {
    const e = (x ?? {}) as Record<string, unknown>;
    const domain = String(e.domain ?? '').toLowerCase();
    const kind = e.kind === 'main' || e.kind === 'secondary' || e.kind === 'subdomain' ? e.kind : undefined;
    const dirs = Array.isArray(e.protected_dirs) ? e.protected_dirs.map(String) : [];
    if (typeof e.account_id !== 'number' || !DOMAIN_RE.test(domain) || !kind || dirs.length > 100 || dirs.some((d) => !DIR_RE.test(d) || d.split('/').some((p) => p === '.' || p === '..'))) {
      throw new Error('Unexpected client area site entry');
    }
    return { account_id: e.account_id, domain, kind, protected_dirs: dirs, ...(typeof e.site_setup === 'string' && e.site_setup ? { site_setup: e.site_setup } : {}) };
  });
}

/** One site of a hosting service as the client area sees it now (layout refresh). */
export interface LayoutSite {
  domain: string;
  kind: 'main' | 'secondary' | 'subdomain';
  protected_dirs: string[];
}

/** A hosting service can have many domains; more than this is treated as a malformed answer. */
export const MAX_SITES_PER_SERVICE = 200;

/** Validates the client area's layout answer; throws on anything unexpected. */
export function parseLayout(raw: unknown): LayoutSite[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SITES_PER_SERVICE) throw new Error('Unexpected client area layout');
  return raw.map((x) => {
    const e = (x ?? {}) as Record<string, unknown>;
    const domain = String(e.domain ?? '').toLowerCase();
    const kind = e.kind === 'main' || e.kind === 'secondary' || e.kind === 'subdomain' ? e.kind : undefined;
    const dirs = Array.isArray(e.protected_dirs) ? e.protected_dirs.map(String) : null;
    if (!DOMAIN_RE.test(domain) || !kind || !dirs || dirs.length > 100 || dirs.some((d) => !DIR_RE.test(d) || d.split('/').some((p) => p === '.' || p === '..'))) {
      throw new Error('Unexpected client area layout entry');
    }
    return { domain, kind, protected_dirs: dirs };
  });
}

export interface ClientAreaApi {
  exchange(code: string, rid: string): Promise<ClientAreaGrant | null>;
  /** The service's current sites and their protected folders. Throws when the client area can't answer. */
  layout?(serviceId: number): Promise<LayoutSite[]>;
}

export class ClientAreaClient implements ClientAreaApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiId: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async exchange(code: string, rid: string): Promise<ClientAreaGrant | null> {
    const body = new URLSearchParams({ api_id: this.apiId, api_key: this.apiKey, call: 'module', module: 'crsconnect', fn: 'exchange', code, rid });
    const res = await this.fetchImpl(`${this.baseUrl}/admin/api.php`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Client area API HTTP ${res.status}`);
    const j = (await res.json()) as Record<string, unknown>;
    // Any non-success means "start over" for the user. Log the client area's reason for operators
    // (e.g. "Your IP is not permitted to use this API ID / KEY"); it never contains the code or key.
    if (j.success !== true) {
      const reason = [j.error, (j as { errors?: unknown }).errors].flat().filter(Boolean).map(String).join('; ').slice(0, 300);
      console.warn(JSON.stringify({ t: new Date().toISOString(), event: 'client_area_exchange_refused', reason: reason || 'no reason given' }));
      return null;
    }
    const scope = j.scope === 'preview' || j.scope === 'publish' || j.scope === 'approve' ? j.scope : null;
    if (typeof j.client_id !== 'number' || typeof j.account_id !== 'number' || typeof j.domain !== 'string' || !scope) {
      throw new Error('Unexpected client area exchange response');
    }
    return {
      client_id: j.client_id, account_id: j.account_id, domain: j.domain, server_id: String(j.server_id ?? ''), scope,
      ...(typeof j.site_setup === 'string' && j.site_setup ? { site_setup: j.site_setup } : {}),
      ...(j.sites !== undefined ? { sites: parseSites(j.sites) } : {}),
    };
  }

  async layout(serviceId: number): Promise<LayoutSite[]> {
    const body = new URLSearchParams({ api_id: this.apiId, api_key: this.apiKey, call: 'module', module: 'crsconnect', fn: 'layout', service_id: String(serviceId) });
    const res = await this.fetchImpl(`${this.baseUrl}/admin/api.php`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Client area API HTTP ${res.status}`);
    const j = (await res.json()) as Record<string, unknown>;
    if (j.success !== true) {
      const reason = [j.error, (j as { errors?: unknown }).errors].flat().filter(Boolean).map(String).join('; ').slice(0, 300);
      throw new Error(`Client area layout refused: ${reason || 'no reason given'}`);
    }
    if (j.service_id !== serviceId) throw new Error('Unexpected client area layout response');
    return parseLayout(j.sites);
  }
}
