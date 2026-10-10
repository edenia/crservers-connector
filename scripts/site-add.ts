/**
 * Pilot: register a site whose deploy FTP user was created by hand in SiteWorx.
 *   pnpm site:add --account 15 --domain example.com --ftp-host iwx41.crservers.com --ftp-user crsconnect@example.com
 * Reads the FTP password from stdin (never from argv, so it stays out of shell history).
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { fromB64url } from '../src/crypto.js';
import { migrate } from '../src/db/migrate.js';
import { SiteRepo } from '../src/sites.js';

const { values } = parseArgs({
  options: { account: { type: 'string' }, domain: { type: 'string' }, 'ftp-host': { type: 'string' }, 'ftp-user': { type: 'string' } },
});
if (!values.account || !values.domain || !values['ftp-host'] || !values['ftp-user']) {
  console.error('usage: site:add --account <hostbill account id> --domain <domain> --ftp-host <node hostname> --ftp-user <user@domain>  (password on stdin)');
  process.exit(2);
}
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const password = Buffer.concat(chunks).toString('utf8').trim();
if (!password) {
  console.error('FTP password expected on stdin');
  process.exit(2);
}

const cfg = loadConfig();
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL });
await migrate(pool);
const site = await new SiteRepo(pool, fromB64url(cfg.ENCRYPTION_KEY)).add({
  hbAccountId: Number(values.account),
  domain: values.domain,
  ftpHost: values['ftp-host'],
  ftpUser: values['ftp-user'],
  ftpPassword: password,
});
console.log(`site registered: ${site.id} (${site.domain}, HostBill account ${site.hbAccountId})`);
await pool.end();
