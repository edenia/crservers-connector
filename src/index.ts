import pg from 'pg';
import { PgClientsStore } from './auth/clients.js';
import { ClientAreaClient } from './auth/clientarea.js';
import { ConnectorOAuthProvider } from './auth/provider.js';
import { loadConfig } from './config.js';
import { fromB64url } from './crypto.js';
import { migrate } from './db/migrate.js';
import { DeployCore } from './deploy/core.js';
import { FtpSiteFs } from './deploy/ftpfs.js';
import { AuditLog, PgBlobStore, PgDraftStore, PgReleaseStore } from './deploy/pgstores.js';
import { createApp } from './http.js';
import { SiteRepo } from './sites.js';

const cfg = loadConfig();
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 10 });
const applied = await migrate(pool);
if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);

const sites = new SiteRepo(pool, fromB64url(cfg.ENCRYPTION_KEY));
const clients = new PgClientsStore(pool, cfg.redirectAllowlist);
const provider = new ConnectorOAuthProvider({
  pool,
  clients,
  sites,
  clientArea: new ClientAreaClient(cfg.CLIENT_AREA_URL, cfg.CLIENT_AREA_API_ID, cfg.CLIENT_AREA_API_KEY),
  issuer: cfg.PUBLIC_URL,
  mcpUrl: cfg.mcpUrl,
  clientAreaUrl: cfg.CLIENT_AREA_URL,
  reqKey: fromB64url(cfg.REQ_KEY),
});

const core = new DeployCore({ drafts: new PgDraftStore(pool), releases: new PgReleaseStore(pool), blobs: new PgBlobStore(pool) });
const mcp = { core, sites, audit: new AuditLog(pool), openFs: async (siteId: string) => new FtpSiteFs(await sites.ftpConfig(siteId)), appName: (id: string) => clients.displayName(id) };

const app = createApp({ provider, issuer: cfg.PUBLIC_URL, mcpUrl: cfg.mcpUrl, mcp });
const server = app.listen(cfg.PORT, () => console.log(`crservers-connector listening on :${cfg.PORT} (${cfg.PUBLIC_URL})`));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
  });
}
