import type { Pool } from 'pg';
import type { ClientAreaApi } from '../auth/clientarea.js';
import { newRef } from '../crypto.js';

/**
 * Feedback from the chat (send_feedback): a bug, a problem or an idea, in the user's words, written by
 * the assistant and confirmed by the user. Stored with what support needs to place it (site, app, the
 * reference of the last failed call) and delivered as a support ticket in the client's own account
 * through the client area. The row is saved first: a client area that is down delays the ticket, never
 * loses the feedback (retried by retryUndelivered, with growing waits, for 3 days). Kept RETENTION.feedbackDays (src/db/cleanup.ts),
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
/** Wait before the first retry, in seconds; doubled after each attempt (5 minutes, 10, 20… up to about 5 hours). */
const RETRY_BASE_S = 300;

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
    const row = await this.store(f);
    const ticket = await this.deliver(row);
    return { reference: row.ref, ...(ticket ? { ticket } : {}) };
  }

  /** Counts and inserts in one transaction, one sender at a time, so parallel calls can't all pass the limit. */
  private async store(f: FeedbackInput): Promise<Row> {
    const sender = f.grantId ?? `${f.clientId} ${f.siteId}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(727003, hashtext($1))', [sender]);
      const sent = f.grantId
        ? await client.query(`SELECT count(*)::int AS n FROM feedback WHERE grant_id = $1 AND at > now() - interval '24 hours'`, [f.grantId])
        : await client.query(`SELECT count(*)::int AS n FROM feedback WHERE client_id = $1 AND site_id = $2 AND at > now() - interval '24 hours'`, [f.clientId, f.siteId]);
      if (sent.rows[0].n >= FEEDBACK_PER_DAY) throw new FeedbackLimit();
      // The last call of this app on this site that failed: what the user is most likely writing about.
      const failed = await client.query(
        `SELECT ref FROM support_events WHERE kind = 'tool_call' AND ok = false AND ref IS NOT NULL AND client_id = $1 AND $2 = ANY(site_ids)
           AND at > now() - interval '24 hours' ORDER BY at DESC, id DESC LIMIT 1`,
        [f.clientId, f.siteId],
      );
      // next_attempt_at: the first delivery (right after this) owns the row for a while; the retry job leaves it alone.
      const row: Row = (await client.query(
        `INSERT INTO feedback (ref, kind, message, site_id, service_id, domain, grant_id, client_id, app, last_failed_ref, draft, attempts, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, now() + make_interval(secs => $12))
         RETURNING id, ref, kind, message, service_id, domain, app, last_failed_ref, draft`,
        [newRef(), f.kind, f.message, f.siteId, f.serviceId, f.domain, f.grantId ?? null, f.clientId, f.app.slice(0, 60), failed.rows[0]?.ref ?? null, f.draft ? JSON.stringify(f.draft) : null, RETRY_BASE_S],
      )).rows[0];
      await client.query('COMMIT');
      return row;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
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

  /**
   * Tries again the messages whose ticket couldn't be opened. Each row is claimed first (its next
   * attempt is pushed back, doubling each time), so a row is never worked on twice at once, whether by
   * two replicas or by a delivery still in flight. The client area opens one ticket per reference, so an
   * attempt whose answer was lost doesn't open a second one. Returns how many were delivered.
   */
  async retryUndelivered(): Promise<number> {
    const rows: Row[] = (await this.pool.query(
      `UPDATE feedback SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $2 * power(2, least(attempts, 6)))
       WHERE id IN (
         SELECT id FROM feedback
         WHERE delivered_at IS NULL AND next_attempt_at <= now() AND at > now() - make_interval(days => $1)
         ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING id, ref, kind, message, service_id, domain, app, last_failed_ref, draft`,
      [RETRY_DAYS, RETRY_BASE_S],
    )).rows;
    let delivered = 0;
    for (const r of rows) if (await this.deliver(r)) delivered++;
    return delivered;
  }
}

/** Looks for undelivered feedback that is due every 5 minutes. Returns a stop function. */
export function scheduleFeedbackRetry(feedback: FeedbackService, everyMs = 5 * 60 * 1000): () => void {
  const timer = setInterval(() => void feedback.retryUndelivered().catch(() => undefined), everyMs);
  return () => clearInterval(timer);
}
