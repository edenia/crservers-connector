import { describe, expect, it } from 'vitest';
import { parseSites } from '../src/auth/clientarea.js';
import { chooseSite } from '../src/mcp/tools.js';
import type { Site } from '../src/sites.js';

const site = (domain: string): Site => ({ id: domain, serviceId: 1, domain, kind: 'main', status: 'active', approveEveryPublish: false, protectedDirs: [], layoutCheckedAt: null });

describe('client area sites list', () => {
  it('accepts main, secondary and subdomain entries', () => {
    expect(parseSites([
      { account_id: 5, domain: 'Selva.example', kind: 'main', protected_dirs: ['dev', 'shop/beta'], site_setup: 'v1.x.y.z' },
      { account_id: 5, domain: 'dev.selva.example', kind: 'subdomain' },
    ])).toEqual([
      { account_id: 5, domain: 'selva.example', kind: 'main', protected_dirs: ['dev', 'shop/beta'], site_setup: 'v1.x.y.z' },
      { account_id: 5, domain: 'dev.selva.example', kind: 'subdomain', protected_dirs: [] },
    ]);
  });

  it('refuses anything unexpected', () => {
    for (const bad of [
      [],
      'selva.example',
      [{ account_id: '5', domain: 'selva.example', kind: 'main' }],
      [{ account_id: 5, domain: 'not a domain', kind: 'main' }],
      [{ account_id: 5, domain: 'selva.example', kind: 'pointer' }],
      [{ account_id: 5, domain: 'selva.example', kind: 'main', protected_dirs: ['../etc'] }],
      [{ account_id: 5, domain: 'selva.example', kind: 'main', protected_dirs: ['/abs'] }],
      Array.from({ length: 26 }, (_, i) => ({ account_id: 5, domain: `s${i}.example`, kind: 'secondary' })),
    ]) {
      expect(() => parseSites(bad), JSON.stringify(bad).slice(0, 60)).toThrow();
    }
  });
});

describe('choosing the site for a tool call', () => {
  const two = [site('carrot.example'), site('selva.example')];

  it('uses the only site, or the one named (URL forms and www accepted)', () => {
    expect(chooseSite([site('selva.example')])).toMatchObject({ site: { domain: 'selva.example' } });
    expect(chooseSite(two, 'HTTPS://www.Selva.example:443/contact')).toMatchObject({ site: { domain: 'selva.example' } });
  });

  it('asks which site when there are several, and names them', () => {
    const r = chooseSite(two);
    expect('error' in r && r.error).toContain('carrot.example, selva.example');
    expect('error' in chooseSite(two, 'other.example')).toBe(true);
  });
});
