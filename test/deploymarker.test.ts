import { describe, expect, it } from 'vitest';
import { DEPLOY_MARKER, deployedFrom, readDeployMarker } from '../src/deploy/deploymarker.js';
import { MemorySiteFs } from '../src/deploy/sitefs.js';

const marker = (o: Record<string, unknown>) => new MemorySiteFs({ [DEPLOY_MARKER]: JSON.stringify(o), 'index.html': '<h1>x</h1>' });

describe('CR Servers Deploy marker', () => {
  it('reads what the deploy workflow writes', async () => {
    const m = await readDeployMarker(marker({ tool: 'crservers-static-deploy', version: 'v1.4.0', repository: 'acme/site', ref: 'refs/heads/main', commit: '0123456789abcdef0123456789abcdef01234567', deployed_at: '2026-10-16T18:00:00Z' }));
    expect(m && deployedFrom(m)).toEqual({ repository: 'acme/site', commit: '0123456789ab', ref: 'refs/heads/main', deployed_at: '2026-10-16T18:00:00.000Z' });
  });

  it('ignores sites without one, and anything that does not look like ours', async () => {
    expect(await readDeployMarker(new MemorySiteFs({ 'index.html': 'x' }))).toBeNull();
    for (const bad of [
      { tool: 'other', repository: 'acme/site', commit: 'abcdef1' },
      { tool: 'crservers-static-deploy', repository: 'acme/site; rm -rf /', commit: 'abcdef1' },
      { tool: 'crservers-static-deploy', repository: 'acme/site', commit: 'not-a-sha' },
    ]) {
      expect(await readDeployMarker(marker(bad)), JSON.stringify(bad)).toBeNull();
    }
    expect(await readDeployMarker(new MemorySiteFs({ [DEPLOY_MARKER]: '{not json' }))).toBeNull();
    expect(await readDeployMarker(new MemorySiteFs({ [DEPLOY_MARKER]: 'x'.repeat(5000) }))).toBeNull();
  });
});
