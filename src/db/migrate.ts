import type { Pool } from 'pg';

/** Forward-only migrations, applied in order inside one transaction each. */
const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_oauth_and_sites',
    sql: `
      CREATE TABLE sites (
        id               uuid PRIMARY KEY,
        hb_account_id    integer NOT NULL UNIQUE,
        domain           text NOT NULL,
        ftp_host         text NOT NULL,
        ftp_user         text NOT NULL,
        ftp_password_enc text NOT NULL,
        status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
        created_at       timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE oauth_clients (
        client_id   text PRIMARY KEY,
        info        jsonb NOT NULL,
        source      text NOT NULL CHECK (source IN ('dcr', 'cimd')),
        created_at  timestamptz NOT NULL DEFAULT now(),
        refreshed_at timestamptz NOT NULL DEFAULT now()
      );

      -- One row per /authorize: waits for the HostBill round trip.
      CREATE TABLE auth_requests (
        rid            text PRIMARY KEY,
        client_id      text NOT NULL REFERENCES oauth_clients(client_id),
        redirect_uri   text NOT NULL,
        code_challenge text NOT NULL,
        state          text,
        scopes         text[] NOT NULL DEFAULT '{}',
        resource       text,
        binding_hash   text NOT NULL,
        expires_at     timestamptz NOT NULL,
        used_at        timestamptz
      );

      -- A connection: one AI client authorized for one site by one HostBill client.
      CREATE TABLE grants (
        id            uuid PRIMARY KEY,
        client_id     text NOT NULL REFERENCES oauth_clients(client_id),
        hb_client_id  integer NOT NULL,
        site_id       uuid NOT NULL REFERENCES sites(id),
        permission    text NOT NULL CHECK (permission IN ('preview', 'publish')),
        scopes        text[] NOT NULL,
        resource      text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        revoked_at    timestamptz
      );
      CREATE INDEX grants_hb_client ON grants (hb_client_id);

      CREATE TABLE auth_codes (
        code_hash      text PRIMARY KEY,
        grant_id       uuid NOT NULL REFERENCES grants(id),
        client_id      text NOT NULL,
        redirect_uri   text NOT NULL,
        code_challenge text NOT NULL,
        expires_at     timestamptz NOT NULL,
        used_at        timestamptz
      );

      CREATE TABLE tokens (
        token_hash   text PRIMARY KEY,
        kind         text NOT NULL CHECK (kind IN ('access', 'refresh')),
        grant_id     uuid NOT NULL REFERENCES grants(id),
        client_id    text NOT NULL,
        expires_at   timestamptz NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        revoked_at   timestamptz,
        replaced_at  timestamptz
      );
      CREATE INDEX tokens_grant ON tokens (grant_id);
    `,
  },
];

export async function migrate(pool: Pool): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        applied.push(m.id);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
  return applied;
}
