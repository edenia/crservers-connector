import type { Pool } from 'pg';
import type { ClientAreaApi } from '../auth/clientarea.js';
import { newRef } from '../crypto.js';

/**
 * Feedback from the chat (send_feedback): a bug, a problem or an idea, in the user's words, written by
 * the assistant and confirmed by the user. Stored with what support needs to place it (site, app, the
 * reference of the last failed call) and delivered as a support ticket in the client's own account
 * through the client area. The row is saved first: a client area that is down delays the ticket, never
 * loses the feedback (retried by retryUndelivered). Kept RETENTION.feedbackDays (src/db/cleanup.ts),
 * stated in the privacy policy.
 */
export const FEEDBACK_KINDS = ['bug', 'idea', 'problem'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_MIN_CHARS = 10;
export const FEEDBACK_MAX_CHARS = 2000;
/** Messages one connection may send per 24 hours. */
export const FEEDBACK_PER_DAY = 10;
/** How long an undelivered message keeps being retried. */
const RETRY_DAYS = 3;

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  siteId: string;
  serviceId: number;
  domain: string;
  grantId?: string;
  clientId: string;
  app: string;
  /** What the draft holds, when the feedback is about one: counts only, never paths or content. */
  draft?: { added: number; modified: number; deleted: number };
}

export interface FeedbackResult {
  /** Short reference the user can quote to support. */
  reference: string;
  /** The support ticket's number, when the client area opened it right away. */
  ticket?: string;
}

export class FeedbackLimit extends Error {}

type Row = { id: string; ref: string; kind: FeedbackKind; message: string; service_id: number; domain: string; app: string | null; last_failed_ref: string | null; draft: FeedbackInput['draft'] | null };

export class FeedbackService {
  constructor(
    private readonly pool: Pool,
    private readonly clientArea: Pick<ClientAreaApi, 'feedback'>,
  ) {}

  async send(f: FeedbackInput): Promise<FeedbackResult> {
    const sent = f.grantId
      ? await this.pool.query(`SELECT count(*)::int AS n FROM feedback WHERE grant_id = $1 AND at > now() - interval '24 hours'`, [f.grantId])
      : await this.pool.query(`SELECT count(*)::int AS n FROM feedback WHERE client_id = $1 AND site_id = $2 AND at > now() - interval '24 hours'`, [f.clientId, f.siteId]);
    if (sent.rows[0].n >= FEEDBACK_PER_DAY) throw new FeedbackLimit();
    // The last call of this app on this site that failed: what the user is most likely writing about.
    const failed = await this.pool.query(
      `SELECT ref FROM support_events WHERE kind = 'tool_call' AND ok = false AND ref IS NOT NULL AND client_id = $1 AND $2 = ANY(site_ids)
         AND at > now() - interval '24 hours' ORDER BY at DESC, id DESC LIMIT 1`,
      [f.clientId, f.siteId],
    );
    const row: Row = (await this.pool.query(
      `INSERT INTO feedback (ref, kind, message, site_id, service_id, domain, grant_id, client_id, app, last_failed_ref, draft)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, ref, kind, message, service_id, domain, app, last_failed_ref, draft`,
      [newRef(), f.kind, f.message, f.siteId, f.serviceId, f.domain, f.grantId ?? null, f.clientId, f.app.slice(0, 60), failed.rows[0]?.ref ?? null, f.draft ? JSON.stringify(f.draft) : null],
    )).rows[0];
    const ticket = await this.deliver(row);
    return { reference: row.ref, ...(ticket ? { ticket } : {}) };
  }

  /** Opens the ticket; on failure the row stays undelivered and is retried later. Never throws. */
  private async deliver(row: Row): Promise<string | undefined> {
    try {
      if (!this.clientArea.feedback) return undefined;
      const { ticket } = await this.clientArea.feedback({
        serviceId: row.service_id,
        domain: row.domain,
        kind: row.kind,
        message: row.message,
        reference: row.ref,
        app: row.app ?? '',
        lastFailedRef: row.last_failed_ref ?? undefined,
        draft: row.draft ?? undefined,
      });
      await this.pool.query('UPDATE feedback SET ticket = $2, delivered_at = now() WHERE id = $1', [row.id, ticket]);
      return ticket;
    } catch (e) {
      // The reason only: never the message text.
      console.warn(JSON.stringify({ t: new Date().toISOString(), event: 'feedback_delivery_failed', ref: row.ref, error: (e as Error).message.slice(0, 200) }));
      return undefined;
    }
  }

  /** Tries again the messages whose ticket couldn't be opened. Returns how many were delivered. */
  async retryUndelivered(): Promise<number> {
    const rows: Row[] = (await this.pool.query(
      `SELECT id, ref, kind, message, service_id, domain, app, last_failed_ref, draft FROM feedback
       WHERE delivered_at IS NULL AND at > now() - make_interval(days => $1) ORDER BY at LIMIT 20`,
      [RETRY_DAYS],
    )).rows;
    let delivered = 0;
    for (const r of rows) if (await this.deliver(r)) delivered++;
    return delivered;
  }
}

/** Retries undelivered feedback every 15 minutes. Returns a stop function. */
export function scheduleFeedbackRetry(feedback: FeedbackService, everyMs = 15 * 60 * 1000): () => void {
  const timer = setInterval(() => void feedback.retryUndelivered().catch(() => undefined), everyMs);
  return () => clearInterval(timer);
}
