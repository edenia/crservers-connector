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
    // Failures carry no detail; any non-success means "start over".
    if (j.success !== true) return null;
    const scope = j.scope === 'preview' || j.scope === 'publish' || j.scope === 'approve' ? j.scope : null;
    if (typeof j.client_id !== 'number' || typeof j.account_id !== 'number' || typeof j.domain !== 'string' || !scope) {
      throw new Error('Unexpected client area exchange response');
    }
    return { client_id: j.client_id, account_id: j.account_id, domain: j.domain, server_id: String(j.server_id ?? ''), scope };
  }
}
