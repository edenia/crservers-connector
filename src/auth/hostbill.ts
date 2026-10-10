/**
 * Server-to-server calls to the HostBill plugin's API function (spike 0d):
 *   POST {HOSTBILL_URL}/admin/api.php  call=module&module=crsconnect&fn=exchange&code&rid
 * The API key should be limited to the `module` method and IP-locked to our egress.
 */
export interface HostbillGrant {
  client_id: number;
  account_id: number;
  domain: string;
  server_id: string;
  scope: 'preview' | 'publish';
}

export interface HostbillApi {
  exchange(code: string, rid: string): Promise<HostbillGrant | null>;
}

export class HostbillClient implements HostbillApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiId: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async exchange(code: string, rid: string): Promise<HostbillGrant | null> {
    const body = new URLSearchParams({ api_id: this.apiId, api_key: this.apiKey, call: 'module', module: 'crsconnect', fn: 'exchange', code, rid });
    const res = await this.fetchImpl(`${this.baseUrl}/admin/api.php`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HostBill API HTTP ${res.status}`);
    const j = (await res.json()) as Record<string, unknown>;
    // HostBill drops module data on failure; any non-success means "start over".
    if (j.success !== true) return null;
    const scope = j.scope === 'preview' ? 'preview' : j.scope === 'publish' ? 'publish' : null;
    if (typeof j.client_id !== 'number' || typeof j.account_id !== 'number' || typeof j.domain !== 'string' || !scope) {
      throw new Error('Unexpected HostBill exchange response');
    }
    return { client_id: j.client_id, account_id: j.account_id, domain: j.domain, server_id: String(j.server_id ?? ''), scope };
  }
}
