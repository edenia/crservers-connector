import { describe, expect, it } from 'vitest';
import { parseLayout, type ClientAreaApi, type LayoutSite } from '../src/auth/clientarea.js';
import { LayoutSync, LayoutUnavailable } from '../src/auth/layout.js';
import type { Site, SiteRepo } from '../src/sites.js';

const mk = (domain: string, kind: Site['kind'], protectedDirs: string[], checked: Date | null = null): Site => ({
  id: domain, serviceId: 88, domain, kind, status: 'active', approveEveryPublish: false, protectedDirs, layoutCheckedAt: checked,
});

/** Just enough of SiteRepo for LayoutSync, in memory. */
function repo(sites: Site[]) {
  const byId = new Map(sites.map((s) => [s.id, { ...s }]));
  return {
    byId: async (id: string) => byId.get(id),
    byService: async (n: number) => [...byId.values()].filter((s) => s.serviceId === n),
    setLayout: async (id: string, kind: Site['kind'], dirs: string[]) => {
      const s = byId.get(id)!;
      byId.set(id, { ...s, kind, protectedDirs: dirs, layoutCheckedAt: new Date() });
    },
  } as unknown as SiteRepo;
}

describe('client area layout answer', () => {
  it('accepts sites with their protected folders', () => {
    expect(parseLayout([{ domain: 'Carrotico.example', kind: 'main', protected_dirs: ['api'] }, { domain: 'api.carrotico.example', kind: 'subdomain', protected_dirs: [] }])).toEqual([
      { domain: 'carrotico.example', kind: 'main', protected_dirs: ['api'] },
      { domain: 'api.carrotico.example', kind: 'subdomain', protected_dirs: [] },
    ]);
  });

  it('refuses anything unexpected', () => {
    for (const bad of [[], 'x', [{ domain: 'a.example', kind: 'main' }], [{ domain: 'a.example', kind: 'pointer', protected_dirs: [] }], [{ domain: 'a.example', kind: 'main', protected_dirs: ['../x'] }]]) {
      expect(() => parseLayout(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('layout refresh', () => {
  const answer = (sites: LayoutSite[]): ClientAreaApi => ({ exchange: async () => null, layout: async () => sites });

  it('picks up a subdomain created after connecting, for every site of the service', async () => {
    const r = repo([mk('carrotico.example', 'main', []), mk('realty.example', 'secondary', [])]);
    let calls = 0;
    const ca: ClientAreaApi = { exchange: async () => null, layout: async () => (calls++, [
      { domain: 'carrotico.example', kind: 'main', protected_dirs: ['api'] },
      { domain: 'realty.example', kind: 'secondary', protected_dirs: [] },
      { domain: 'api.carrotico.example', kind: 'subdomain', protected_dirs: [] },
    ]) };
    const sync = new LayoutSync(r, ca);
    const site = (await r.byId('carrotico.example'))!;
    expect((await sync.fresh(site, true)).protectedDirs).toEqual(['api']);
    // One call per service refreshes its other sites too, and a fresh layout isn't asked again.
    const other = (await r.byId('realty.example'))!;
    expect(other.layoutCheckedAt).not.toBeNull();
    await sync.fresh(other, true);
    expect(calls).toBe(1);
  });

  it('asks again once the stored layout is older than the limit', async () => {
    let now = 1_000_000;
    let calls = 0;
    const r = repo([mk('a.example', 'main', [], new Date(now))]);
    const sync = new LayoutSync(r, { exchange: async () => null, layout: async () => (calls++, [{ domain: 'a.example', kind: 'main', protected_dirs: [] }]) }, 60_000, () => now);
    await sync.fresh((await r.byId('a.example'))!, true);
    expect(calls).toBe(0);
    now += 61_000;
    await sync.fresh((await r.byId('a.example'))!, true);
    expect(calls).toBe(1);
  });

  it('strict refuses when the client area cannot answer; relaxed keeps the stored layout', async () => {
    const r = repo([mk('a.example', 'main', ['dev'])]);
    const sync = new LayoutSync(r, { exchange: async () => null, layout: async () => { throw new Error('down'); } });
    const site = (await r.byId('a.example'))!;
    await expect(sync.fresh(site, true)).rejects.toBeInstanceOf(LayoutUnavailable);
    expect((await sync.fresh(site, false)).protectedDirs).toEqual(['dev']);
    // An older client area without the layout call counts as "can't answer".
    await expect(new LayoutSync(r, { exchange: async () => null }).fresh(site, true)).rejects.toBeInstanceOf(LayoutUnavailable);
  });

  it('a site missing from the answer keeps its stored layout', async () => {
    const r = repo([mk('gone.example', 'subdomain', ['x'])]);
    const sync = new LayoutSync(r, answer([{ domain: 'other.example', kind: 'main', protected_dirs: [] }]));
    expect((await sync.fresh((await r.byId('gone.example'))!, true)).protectedDirs).toEqual(['x']);
  });
});
