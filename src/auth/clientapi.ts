import express, { type Request, type Response, type Router } from 'express';
import type { Pool } from 'pg';
import type { AuditLog } from '../deploy/pgstores.js';
import type { SiteRepo } from '../sites.js';
import { verifySigned } from './sitesetup.js';

/**
 * Client-area API (docs/ARCHITECTURE.md, "Managing connections"): what the client area's
 * AI Connect page shows and changes. Called server-to-server by the client-area extension,
 * signed with REQ_KEY (same scheme as lifecycle events). The client area has already checked that
 * the signed-in client owns the service; this API trusts that, as it trusts the code exchange.
 *
 *   POST /client-area/api/site      {service_id, domain?}                         → site, connections, activity
 *   POST /client-area/api/revoke    {service_id, domain?, grant_id | "all"}       → {revoked}
 *   POST /client-area/api/settings  {service_id, domain?, approve_every_publish}  → {approve_every_publish}
 *
 * `domain` picks one site of the service (main domain when omitted). A connection can cover several
 * sites: revoking takes this site out of it, and ends it when no sites are left.
 */
export interface ClientApiDeps {
  pool: Pool;
  sites: SiteRepo;
  audit: AuditLog;
  reqKey: Buffer;
  /** Takes a site out of one connection (ending it when no sites are left). */
  removeSite: (grantId: string, siteId: string) => Promise<void>;
  appName?: (clientId: string) => Promise<string>;
}

export function clientAreaApi(d: ClientApiDeps): Router {
  const r = express.Router();
  r.use(express.raw({ type: 'application/json', limit: '4kb' }));

  /** Signed, fresh, single-use (nonce), with a valid service_id; otherwise answers 401/400 and returns null. */
  const guard = async (req: Request, res: Response) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const j = verifySigned(d.reqKey, body, req.get('x-crs-signature') ?? '');
    if (!j) return void res.status(401).json({ ok: false });
    const serviceId = Number(j.service_id);
    const domain = j.domain === undefined ? undefined : String(j.domain).toLowerCase();
    if (!Number.isInteger(serviceId) || serviceId <= 0 || (domain !== undefined && !/^[a-z0-9.-]{3,253}$/.test(domain))) return void res.status(400).json({ ok: false });
    const fresh = await d.pool.query('INSERT INTO client_area_events (nonce, service_id, event) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [j.nonce, serviceId, `api${req.path}`]);
    if (fresh.rowCount === 0) return void res.status(409).json({ ok: false, error: 'replay' });
    return { j, serviceId, domain };
  };
  const name = (cache: Map<string, string>) => async (id: string) => {
    if (id === 'owner') return 'owner';
    if (!cache.has(id)) cache.set(id, d.appName ? await d.appName(id) : id);
    return cache.get(id)!;
  };
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: (e: unknown) => void) => void fn(req, res).catch(next);

  r.post('/site', wrap(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    const site = await d.sites.byAccount(g.serviceId, g.domain);
    if (!site) return void res.json({ ok: true, site: null, connections: [], activity: [] });
    const appName = name(new Map());
    const grants = (await d.pool.query(
      `SELECT g.id, g.client_id, g.permission, g.created_at,
              (SELECT max(created_at) FROM tokens k WHERE k.grant_id = g.id AND k.kind = 'access') AS last_used,
              ARRAY(SELECT s.domain FROM grant_sites o JOIN sites s ON s.id = o.site_id WHERE o.grant_id = g.id AND o.site_id <> $1 ORDER BY s.domain) AS other_sites
       FROM grants g JOIN grant_sites gs ON gs.grant_id = g.id
       WHERE gs.site_id = $1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`,
      [site.id],
    )).rows;
    const connections = [];
    for (const x of grants) {
      connections.push({ id: x.id, app: await appName(x.client_id), permission: x.permission, connected_at: x.created_at, last_used_at: x.last_used, other_sites: x.other_sites });
    }
    const activity = [];
    for (const e of await d.audit.recent(site.id, 20)) activity.push({ at: e.at, action: e.action, detail: e.detail, app: await appName(e.clientId) });
    res.json({ ok: true, site: { domain: site.domain, kind: site.kind, status: site.status, approve_every_publish: site.approveEveryPublish }, connections, activity });
  }));

  r.post('/revoke', wrap(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    const site = await d.sites.byAccount(g.serviceId, g.domain);
    const grant = String(g.j.grant_id ?? '');
    if (!site || !grant) return void res.status(404).json({ ok: false });
    const rows = (await d.pool.query(
      `SELECT g.id, g.client_id FROM grants g JOIN grant_sites gs ON gs.grant_id = g.id
       WHERE gs.site_id = $1 AND g.revoked_at IS NULL${grant === 'all' ? '' : ' AND g.id::text = $2'}`,
      grant === 'all' ? [site.id] : [site.id, grant],
    )).rows;
    for (const x of rows) {
      await d.removeSite(x.id, site.id);
      await d.audit.add(site.id, x.client_id, 'connection_revoked', { grant_id: x.id, by: 'owner' });
    }
    res.json({ ok: true, revoked: rows.length });
  }));

  r.post('/settings', wrap(async (req, res) => {
    const g = await guard(req, res);
    if (!g) return;
    const on = g.j.approve_every_publish === true;
    const site = await d.sites.byAccount(g.serviceId, g.domain);
    const row = site && (await d.pool.query('UPDATE sites SET approve_every_publish = $2 WHERE id = $1 RETURNING id', [site.id, on])).rows[0];
    if (!row) return void res.status(404).json({ ok: false });
    await d.audit.add(row.id, 'owner', 'settings_changed', { approve_every_publish: on });
    res.json({ ok: true, approve_every_publish: on });
  }));

  return r;
}
