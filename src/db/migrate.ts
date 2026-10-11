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

      -- One row per /authorize: waits for the client-area round trip.
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

      -- A connection: one AI client authorized for one site by one client-area account.
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
  {
    id: '002_deploy_state',
    sql: `
      CREATE TABLE drafts (
        id                 uuid PRIMARY KEY,
        site_id            uuid NOT NULL REFERENCES sites(id),
        note               text NOT NULL DEFAULT '',
        created_at         timestamptz NOT NULL,
        expires_at         timestamptz NOT NULL,
        version            integer NOT NULL,
        previewed_version  integer,
        base               jsonb NOT NULL,
        start_fingerprints jsonb NOT NULL,
        early_conflicts    jsonb NOT NULL
      );
      CREATE INDEX drafts_expires ON drafts (expires_at);

      CREATE TABLE draft_files (
        draft_id  uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        path      text NOT NULL,
        deleted   boolean NOT NULL,
        sha256    text,
        content   bytea,
        PRIMARY KEY (draft_id, path)
      );

      CREATE TABLE releases (
        id          uuid PRIMARY KEY,
        site_id     uuid NOT NULL REFERENCES sites(id),
        number      integer NOT NULL,
        created_at  timestamptz NOT NULL,
        cause       text NOT NULL CHECK (cause IN ('publish', 'revert')),
        by_app      text NOT NULL,
        files       jsonb NOT NULL,
        UNIQUE (site_id, number)
      );

      -- Revert-record content (in Postgres for now; an S3-compatible bucket later).
      CREATE TABLE blobs (
        key   text PRIMARY KEY,
        data  bytea NOT NULL
      );

      CREATE TABLE audit_log (
        id         bigserial PRIMARY KEY,
        site_id    uuid NOT NULL REFERENCES sites(id),
        at         timestamptz NOT NULL DEFAULT now(),
        client_id  text NOT NULL,
        action     text NOT NULL,
        detail     jsonb NOT NULL DEFAULT '{}'
      );
      CREATE INDEX audit_site_at ON audit_log (site_id, at DESC);
    `,
  },
  {
    // Neutral names for client-area identifiers (001 is already applied in production; never edit it).
    id: '003_neutral_client_area_columns',
    sql: `
      ALTER TABLE sites RENAME COLUMN hb_account_id TO service_id;
      ALTER TABLE grants RENAME COLUMN hb_client_id TO account_holder_id;
      ALTER INDEX grants_hb_client RENAME TO grants_account_holder;
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
