import type { Pool } from 'pg';

/**
 * Data retention (docs/ARCHITECTURE.md, "Data retention"). Runs daily. Each period here is also
 * stated in the public privacy policy, so change both together.
 */
export const RETENTION = {
  /** Activity log entries. */
  activityDays: 365,
  /** Revoked connections and their tokens and codes, counted from revocation. */
  revokedConnectionDays: 90,
  /** Finished or expired approval requests. */
  approvalDays: 90,
} as const;

export type CleanupCounts = Record<string, number>;

/** Deletes what's past its retention period. Safe to run concurrently (advisory lock) and repeatedly. */
export async function cleanup(pool: Pool): Promise<CleanupCounts> {
  const client = await pool.connect();
  const counts: CleanupCounts = {};
  const run = async (name: string, sql: string, params: unknown[] = []) => {
    counts[name] = (await client.query(sql, params)).rowCount ?? 0;
  };
  try {
    const locked = (await client.query('SELECT pg_try_advisory_lock(727002) AS ok')).rows[0]?.ok;
    if (!locked) return { skipped: 1 };
    try {
      // Short-lived flow state: useless once expired or used.
      await run('auth_requests', `DELETE FROM auth_requests WHERE expires_at < now() - interval '1 day'`);
      await run('auth_codes', `DELETE FROM auth_codes WHERE expires_at < now() - interval '1 day'`);
      await run('approval_signins', `DELETE FROM approval_signins WHERE expires_at < now() - interval '1 day'`);
      await run('manage_signins', `DELETE FROM manage_signins WHERE expires_at < now() - interval '1 day'`);
      await run('manage_sessions', `DELETE FROM manage_sessions WHERE expires_at < now() - interval '1 day'`);
      await run('client_area_events', `DELETE FROM client_area_events WHERE received_at < now() - interval '1 day'`);
      await run('preview_links', `DELETE FROM preview_links WHERE expires_at < now()`);
      // Expired drafts (their staged files and preview links go with them).
      await run('drafts', `DELETE FROM drafts WHERE expires_at < now()`);
      // Tokens: expired ones are dead weight.
      await run('tokens_expired', `DELETE FROM tokens WHERE expires_at < now() - interval '1 day'`);
      // Revoked connections, 90 days after revocation, with everything that points at them.
      const revoked = `SELECT id FROM grants WHERE revoked_at < now() - make_interval(days => $1)`;
      await run('tokens_revoked', `DELETE FROM tokens WHERE grant_id IN (${revoked})`, [RETENTION.revokedConnectionDays]);
      await run('auth_codes_revoked', `DELETE FROM auth_codes WHERE grant_id IN (${revoked})`, [RETENTION.revokedConnectionDays]);
      await run('grants', `DELETE FROM grants WHERE revoked_at < now() - make_interval(days => $1)`, [RETENTION.revokedConnectionDays]);
      // Approvals that were decided or expired long ago.
      await run('approvals', `DELETE FROM approvals WHERE COALESCE(decided_at, expires_at) < now() - make_interval(days => $1)`, [RETENTION.approvalDays]);
      // Activity log.
      await run('audit_log', `DELETE FROM audit_log WHERE at < now() - make_interval(days => $1)`, [RETENTION.activityDays]);
    } finally {
      await client.query('SELECT pg_advisory_unlock(727002)').catch(() => undefined);
    }
  } finally {
    client.release();
  }
  return counts;
}

/** Runs cleanup now and every 24 hours; logs what it removed. Returns a stop function. */
export function scheduleCleanup(pool: Pool, everyMs = 24 * 3600 * 1000): () => void {
  const tick = () =>
    cleanup(pool)
      .then((c) => console.log(JSON.stringify({ t: new Date().toISOString(), event: 'retention_cleanup', removed: c })))
      .catch((e: Error) => console.error(JSON.stringify({ t: new Date().toISOString(), event: 'retention_cleanup_failed', error: e.message })));
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, everyMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
