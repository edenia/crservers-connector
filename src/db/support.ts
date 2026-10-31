import type { Pool } from 'pg';

/**
 * Support records (connector #56): one row per tool call, per session start and per refused connection
 * (the OAuth callback said access_denied after the client consented) and per refused token refresh, so support can find a
 * customer's problem from a reference id or a hosting service without asking for the time and the app.
 * Ids and outcomes only, never arguments, file contents or results. Kept RETENTION.supportDays
 * (src/db/cleanup.ts), stated in the privacy policy. Request logs (stdout) carry only the random ref.
 */
export interface SupportEvent {
  kind: 'tool_call' | 'initialize' | 'connect_refused' | 'refresh_refused';
  ref?: string;
  tool?: string;
  ok?: boolean;
  error?: string;
  siteIds?: string[];
  serviceId?: number;
  clientId?: string;
  app?: string;
  appVersion?: string;
}

export class SupportLog {
  constructor(private readonly pool: Pool) {}

  /** Never throws: support records must not break or slow down a response. */
  record(e: SupportEvent): void {
    this.pool
      .query(
        `INSERT INTO support_events (kind, ref, tool, ok, error, site_ids, service_id, client_id, app, app_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [e.kind, e.ref ?? null, e.tool ?? null, e.ok ?? null, e.error?.slice(0, 200) ?? null, e.siteIds ?? [], e.serviceId ?? null, e.clientId ?? null, e.app?.slice(0, 60) ?? null, e.appVersion?.slice(0, 30) ?? null],
      )
      .catch((err: Error) => console.error(JSON.stringify({ t: new Date().toISOString(), event: 'support_record_failed', error: err.message })));
  }
}
