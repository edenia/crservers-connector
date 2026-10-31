import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup } from '../src/db/cleanup.js';
import { migrate } from '../src/db/migrate.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:54329/connector';
const schema = `t_${randomBytes(6).toString('hex')}`;
let pool: pg.Pool;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: DB });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new pg.Pool({ connectionString: DB, options: `-c search_path=${schema}` });
  await migrate(pool);
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

const days = (n: number) => `now() - interval '${n} days'`;

describe('retention cleanup', () => {
  it('removes only what is past its period', async () => {
    const site = randomUUID();
    await pool.query(`INSERT INTO sites (id, service_id, domain, ftp_host, ftp_user, ftp_password_enc) VALUES ($1, 1, 'a.example', 'h', 'u', 'x')`, [site]);
    await pool.query(`INSERT INTO oauth_clients (client_id, info, source) VALUES ('c', '{}', 'dcr')`);
    const grant = async (revokedDaysAgo: number | null) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO grants (id, client_id, account_holder_id, site_id, permission, scopes, resource, revoked_at) VALUES ($1, 'c', 1, $2, 'publish', '{site}', 'r', ${revokedDaysAgo === null ? 'NULL' : days(revokedDaysAgo)})`, [id, site]);
      await pool.query(`INSERT INTO tokens (token_hash, kind, grant_id, client_id, expires_at, revoked_at) VALUES ($1, 'refresh', $2, 'c', now() + interval '30 days', ${revokedDaysAgo === null ? 'NULL' : days(revokedDaysAgo)})`, [randomBytes(8).toString('hex'), id]);
      return id;
    };
    const oldRevoked = await grant(120);
    const recentRevoked = await grant(10);
    const active = await grant(null);
    await pool.query(`INSERT INTO tokens (token_hash, kind, grant_id, client_id, expires_at) VALUES ('expired', 'access', $1, 'c', ${days(3)})`, [active]);
    await pool.query(`INSERT INTO audit_log (site_id, client_id, action, at) VALUES ($1, 'c', 'publish', ${days(400)}), ($1, 'c', 'publish', ${days(30)})`, [site]);
    await pool.query(`INSERT INTO support_events (kind, tool, service_id, at) VALUES ('tool_call', 'list_files', 1, ${days(31)}), ('tool_call', 'list_files', 1, ${days(29)})`);
    const draft = (exp: string) => pool.query(`INSERT INTO drafts (id, site_id, created_at, expires_at, version, base, start_fingerprints, early_conflicts) VALUES ($1, $2, now(), ${exp}, 0, '{}', '{}', '[]')`, [randomUUID(), site]);
    await draft(days(2));
    await draft(`now() + interval '1 day'`);
    await pool.query(`INSERT INTO client_area_events (nonce, service_id, event, received_at) VALUES ('old', 1, 'suspend', ${days(2)}), ('new', 1, 'suspend', now())`);

    const counts = await cleanup(pool);
    expect(counts).toMatchObject({ grants: 1, tokens_revoked: 1, tokens_expired: 1, audit_log: 1, drafts: 1, client_area_events: 1, support_events: 1 });
    expect((await pool.query('SELECT count(*)::int n FROM support_events')).rows[0].n).toBe(1);

    const grants = (await pool.query('SELECT id FROM grants ORDER BY id')).rows.map((r) => r.id).sort();
    expect(grants).toEqual([recentRevoked, active].sort());
    expect(grants).not.toContain(oldRevoked);
    expect((await pool.query('SELECT count(*)::int n FROM audit_log')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM drafts')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM tokens')).rows[0].n).toBe(2);

    expect(await cleanup(pool)).toMatchObject({ grants: 0, audit_log: 0 }); // idempotent
  });
});

import { anonymizeIp } from '../src/http.js';
describe('request log IP anonymization', () => {
  it('drops the host part', () => {
    expect(anonymizeIp('203.0.113.42')).toBe('203.0.113.0');
    expect(anonymizeIp('::ffff:198.51.100.7')).toBe('198.51.100.0');
    expect(anonymizeIp('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::');
    expect(anonymizeIp(undefined)).toBe('');
  });
});
