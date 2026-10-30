import pg from 'pg';
import { PgClientsStore } from './auth/clients.js';
import { ClientAreaClient } from './auth/clientarea.js';
import { LayoutSync } from './auth/layout.js';
import { ConnectorOAuthProvider } from './auth/provider.js';
import { loadConfig } from './config.js';
import { fromB64url } from './crypto.js';
import { migrate } from './db/migrate.js';
import { scheduleCleanup } from './db/cleanup.js';
import { SupportLog } from './db/support.js';
import { DeployCore } from './deploy/core.js';
import { FtpSiteFs } from './deploy/ftpfs.js';
import { AuditLog, PgBlobStore, PgDraftStore, PgReleaseStore } from './deploy/pgstores.js';
import { createApp } from './http.js';
import { PreviewService } from './preview/preview.js';
import { ApprovalService } from './approvals/approvals.js';
import { SiteRepo } from './sites.js';

const cfg = loadConfig();
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 10 });
const applied = await migrate(pool);
if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);
const stopCleanup = scheduleCleanup(pool);

const sites = new SiteRepo(pool, fromB64url(cfg.ENCRYPTION_KEY));
const clients = new PgClientsStore(pool, cfg.redirectAllowlist);
const clientArea = new ClientAreaClient(cfg.CLIENT_AREA_URL, cfg.CLIENT_AREA_API_ID, cfg.CLIENT_AREA_API_KEY);
const support = new SupportLog(pool);
const provider = new ConnectorOAuthProvider({
  pool,
  clients,
  sites,
  clientArea,
  issuer: cfg.PUBLIC_URL,
  mcpUrl: cfg.mcpUrl,
  clientAreaUrl: cfg.CLIENT_AREA_URL,
  reqKey: fromB64url(cfg.REQ_KEY),
  support,
});

const core = new DeployCore({ drafts: new PgDraftStore(pool), releases: new PgReleaseStore(pool), blobs: new PgBlobStore(pool) });
const preview = new PreviewService(pool, sites, cfg.PUBLIC_URL);
const audit = new AuditLog(pool);
const openFs = async (siteId: string) => new FtpSiteFs(await sites.ftpConfig(siteId));
const appName = (id: string) => clients.displayName(id);
const layout = new LayoutSync(sites, clientArea);
const approvals = new ApprovalService({
  pool, sites, core, audit, openFs, preview, clientArea, appName, layout,
  clientAreaUrl: cfg.CLIENT_AREA_URL, reqKey: fromB64url(cfg.REQ_KEY), publicUrl: cfg.PUBLIC_URL,
});
const clientApi = { pool, sites, audit, appName, reqKey: fromB64url(cfg.REQ_KEY), removeSite: (grantId: string, siteId: string) => provider.removeSite(grantId, siteId) };
const mcp = { core, sites, preview, approvals, audit, openFs, appName, layout, support };

const app = createApp({ provider, issuer: cfg.PUBLIC_URL, mcpUrl: cfg.mcpUrl, mcp, preview, approvals, clientApi, openaiAppsChallenge: cfg.OPENAI_APPS_CHALLENGE, events: { pool, sites, reqKey: fromB64url(cfg.REQ_KEY) } });
const server = app.listen(cfg.PORT, () => console.log(`crservers-connector listening on :${cfg.PORT} (${cfg.PUBLIC_URL})`));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    stopCleanup();
    server.close(() => void pool.end().then(() => process.exit(0)));
  });
}
