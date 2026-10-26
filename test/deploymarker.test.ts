import { describe, expect, it } from 'vitest';
import { DEPLOY_MARKER, deployNote, deployedFrom, readDeployMarker } from '../src/deploy/deploymarker.js';
import { MemorySiteFs } from '../src/deploy/sitefs.js';

const marker = (o: Record<string, unknown>, files: Record<string, string> = { 'index.html': '<h1>x</h1>' }) => new MemorySiteFs({ [DEPLOY_MARKER]: JSON.stringify(o), ...files });
const ours = { tool: 'crservers-static-deploy', version: 'v2.0.1', repository: 'acme/site', ref: 'refs/heads/main', commit: '0123456789abcdef0123456789abcdef01234567', deployed_at: '2026-10-16T18:00:00Z' };

describe('CR Servers Deploy marker', () => {
  it('reads what the deploy workflow writes', async () => {
    const m = await readDeployMarker(marker({ tool: 'crservers-static-deploy', version: 'v1.4.0', repository: 'acme/site', ref: 'refs/heads/main', commit: '0123456789abcdef0123456789abcdef01234567', deployed_at: '2026-10-16T18:00:00Z' }));
    expect(m && deployedFrom(m)).toEqual({
      repository: 'acme/site',
      repository_url: 'https://github.com/acme/site',
      commit: '0123456789ab',
      commit_url: 'https://github.com/acme/site/commit/0123456789ab',
      ref: 'refs/heads/main',
      deploy_branch: 'main',
      deployed_at: '2026-10-16T18:00:00.000Z',
      guidance: expect.stringContaining('https://github.com/acme/site'),
    });
  });

  it('plain static site: says where the source is and what to do, without the compiled-site wording', async () => {
    const m = (await readDeployMarker(marker(ours, { 'index.html': 'x', 'robots.txt': 'x', 'robots.html': 'x', 'css/site.css': 'x' })))!;
    expect(m.build).toBeUndefined();
    const note = deployNote(m);
    expect(note).toContain('https://github.com/acme/site (branch main, commit 0123456789ab, deployed 2026-10-16T18:00:00.000Z)');
    expect(note).toContain('next deploy');
    expect(note).toMatch(/Codex, Claude Code, Cursor, v0/);
    expect(note).toContain("site's developer");
    expect(note).toContain('Merging the change to main publishes it');
    expect(note).toContain('warn them clearly');
    expect(note).not.toContain('_next');
    expect(note).not.toContain('in-site navigation');
  });

  it('Next.js static export (a _next/ folder, or .txt page data next to pages): says the files are compiled output', async () => {
    for (const files of [
      { 'index.html': 'x', '_next/static/chunks/app-3f9a.js': 'x' },
      { 'index.html': 'x', 'index.txt': 'x', 'about.html': 'x', 'about.txt': 'x' },
    ]) {
      const m = (await readDeployMarker(marker(ours, files)))!;
      expect(m.build, JSON.stringify(files)).toBe('nextjs-export');
      expect(deployedFrom(m)).toMatchObject({ build: 'nextjs-export' });
      const note = deployNote(m);
      expect(note).toContain('compiled Next.js static export');
      expect(note).toContain('hashed _next/ chunks and .txt page data');
      expect(note).toContain('in-site navigation');
    }
  });

  it('without a branch ref, says to merge to the branch that deploys the site', async () => {
    const { ref: _ref, ...noRef } = ours;
    const m = (await readDeployMarker(marker(noRef)))!;
    expect(deployedFrom(m)).not.toHaveProperty('deploy_branch');
    expect(deployNote(m)).toContain('(commit 0123456789ab, deployed');
    expect(deployNote(m)).toContain('Merging the change to the branch that deploys the site publishes it');
    const tag = (await readDeployMarker(marker({ ...ours, ref: 'refs/tags/v1' })))!;
    expect(deployNote(tag)).toContain('ref refs/tags/v1');
    expect(deployedFrom(tag)).not.toHaveProperty('deploy_branch');
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
