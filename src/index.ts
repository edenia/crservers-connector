import pg from 'pg';
import { PgClientsStore } from './auth/clients.js';
import { HostbillClient } from './auth/hostbill.js';
import { ConnectorOAuthProvider } from './auth/provider.js';
import { loadConfig } from './config.js';
import { fromB64url } from './crypto.js';
import { migrate } from './db/migrate.js';
import { createApp } from './http.js';
import { SiteRepo } from './sites.js';

const cfg = loadConfig();
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 10 });
const applied = await migrate(pool);
if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);

const provider = new ConnectorOAuthProvider({
  pool,
  clients: new PgClientsStore(pool, cfg.redirectAllowlist),
  sites: new SiteRepo(pool, fromB64url(cfg.ENCRYPTION_KEY)),
  hostbill: new HostbillClient(cfg.HOSTBILL_URL, cfg.HOSTBILL_API_ID, cfg.HOSTBILL_API_KEY),
  issuer: cfg.PUBLIC_URL,
  mcpUrl: cfg.mcpUrl,
  hostbillUrl: cfg.HOSTBILL_URL,
  reqKey: fromB64url(cfg.REQ_KEY),
});

const app = createApp({ provider, issuer: cfg.PUBLIC_URL, mcpUrl: cfg.mcpUrl });
const server = app.listen(cfg.PORT, () => console.log(`crservers-connector listening on :${cfg.PORT} (${cfg.PUBLIC_URL})`));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
  });
}
