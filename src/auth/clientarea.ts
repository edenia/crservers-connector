/**
 * Server-to-server calls to the client-area extension that handles sign-in and consent:
 *   POST {CLIENT_AREA_URL}/admin/api.php  call=module&module=crsconnect&fn=exchange&code&rid
 * The API key should be limited to the `module` method and IP-locked to our egress.
 */
export interface ClientAreaGrant {
  client_id: number;
  account_id: number;
  domain: string;
  server_id: string;
  /** preview / publish: a new connection. approve: the site owner signed in to approve one publish. */
  scope: 'preview' | 'publish' | 'approve';
  /** First connection of a site: its new deploy user's credentials, sealed (see sitesetup.ts). */
  site_setup?: string;
}

export interface ClientAreaApi {
  exchange(code: string, rid: string): Promise<ClientAreaGrant | null>;
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
    };
  }
}
