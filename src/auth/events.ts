import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { SiteRepo } from '../sites.js';
import type { ConnectorOAuthProvider } from './provider.js';
import { verifyEvent } from './sitesetup.js';

/**
 * POST /client-area/events: service lifecycle from the client area, signed with REQ_KEY
 * (docs/ARCHITECTURE.md, "Automatic site setup").
 * Each event applies to every site (domain) of the hosting service.
 * - suspend: publishing paused (the client area also suspends the deploy user);
 * - unsuspend: resumed;
 * - terminate: paused for good and every connection revoked;
 * - revoke: the service changed owner; its sites are taken out of every connection.
 */
export function clientAreaEvents(d: { pool: Pool; sites: SiteRepo; provider: Pick<ConnectorOAuthProvider, 'revokeSite'>; reqKey: Buffer }) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ev = verifyEvent(d.reqKey, body, req.get('x-crs-signature') ?? '');
    if (!ev) return void res.status(401).json({ ok: false });
    const fresh = await d.pool.query('INSERT INTO client_area_events (nonce, service_id, event) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [ev.nonce, ev.serviceId, ev.event]);
    if (fresh.rowCount === 0) return void res.json({ ok: true, replay: true });

    // Every domain of the hosting service follows the service.
    const sites = await d.sites.byService(ev.serviceId);
    let revoked = 0;
    if (ev.event === 'suspend' || ev.event === 'terminate') await d.sites.setStatus(ev.serviceId, 'frozen');
    if (ev.event === 'unsuspend') await d.sites.setStatus(ev.serviceId, 'active');
    if (ev.event === 'terminate' || ev.event === 'revoke') for (const site of sites) revoked += await d.provider.revokeSite(site.id);
    console.log(JSON.stringify({ t: new Date().toISOString(), event: `client_area_${ev.event}`, service_id: ev.serviceId, sites: sites.length, revoked }));
    res.json({ ok: true });
  };
}
