import type { Site, SiteRepo } from '../sites.js';
import type { ClientAreaApi } from './clientarea.js';

/** Publishing re-checks a site's layout when it was confirmed longer ago than this. */
export const LAYOUT_MAX_AGE_MS = 5 * 60_000;

export class LayoutUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutUnavailable';
  }
}

/**
 * Keeps each site's layout (kind and protected_dirs: folders inside it that belong to other sites)
 * in step with the hosting account. Sign-in stores it once; a subdomain created later would not be
 * protected until the client reconnects. This asks the client area again when the stored layout is
 * older than LAYOUT_MAX_AGE_MS, one call per hosting service, and updates every site of that service.
 *
 * strict = true (publish, revert): refuse when the layout can't be confirmed, so nothing goes live
 * into a folder whose owner is unknown. strict = false (reading, drafting): fall back to the stored
 * layout; publish checks again before anything changes on the live site.
 */
export class LayoutSync {
  private readonly inflight = new Map<number, Promise<void>>();

  constructor(
    private readonly sites: SiteRepo,
    private readonly clientArea: ClientAreaApi,
    private readonly maxAgeMs = LAYOUT_MAX_AGE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async fresh(site: Site, strict: boolean): Promise<Site> {
    if (site.layoutCheckedAt && this.now() - site.layoutCheckedAt.getTime() < this.maxAgeMs) return site;
    try {
      await this.refreshService(site.serviceId);
    } catch (e) {
      console.warn(JSON.stringify({ t: new Date().toISOString(), event: 'layout_refresh_failed', service_id: site.serviceId, domain: site.domain, error: (e as Error).message.slice(0, 300) }));
      if (strict) throw new LayoutUnavailable('Could not confirm the hosting layout');
      return site;
    }
    return (await this.sites.byId(site.id)) ?? site;
  }

  private refreshService(serviceId: number): Promise<void> {
    let p = this.inflight.get(serviceId);
    if (!p) {
      p = this.load(serviceId).finally(() => this.inflight.delete(serviceId));
      this.inflight.set(serviceId, p);
    }
    return p;
  }

  private async load(serviceId: number): Promise<void> {
    if (!this.clientArea.layout) throw new Error('Client area has no layout call');
    const current = await this.clientArea.layout(serviceId);
    const byDomain = new Map(current.map((s) => [s.domain, s]));
    for (const site of await this.sites.byService(serviceId)) {
      const now = byDomain.get(site.domain);
      // A site no longer in the account (e.g. its subdomain was deleted) keeps its stored layout:
      // its folder is gone, so nothing can be published there anyway.
      await this.sites.setLayout(site.id, now?.kind ?? site.kind, now?.protected_dirs ?? site.protectedDirs);
      if (now && (now.protected_dirs.join('\n') !== site.protectedDirs.join('\n') || now.kind !== site.kind)) {
        console.log(JSON.stringify({ t: new Date().toISOString(), event: 'layout_changed', service_id: serviceId, domain: site.domain, protected_dirs: now.protected_dirs }));
      }
    }
  }
}
