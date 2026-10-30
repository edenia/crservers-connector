import { beforeEach, describe, expect, it } from 'vitest';
import { DeployCore } from '../src/deploy/core.js';
import { SITE_GUIDE, isoTime, readSiteGuide, siteGuideInfo, siteGuideNote } from '../src/deploy/siteguide.js';
import { MemorySiteFs } from '../src/deploy/sitefs.js';
import { MemoryBlobStore, MemoryDraftStore, MemoryReleaseStore } from '../src/deploy/stores.js';

const b = (s: string) => Buffer.from(s);

describe('readSiteGuide', () => {
  it('returns the text and the server time of the last change', async () => {
    const fs = new MemorySiteFs({ [SITE_GUIDE]: '# Guía\n- Eventos nuevos arriba.' });
    const g = await readSiteGuide(fs);
    expect(g).toMatchObject({ text: '# Guía\n- Eventos nuevos arriba.', truncated: false });
    expect(siteGuideInfo(g)).toMatchObject({ path: SITE_GUIDE, text: '# Guía\n- Eventos nuevos arriba.' });
    expect(siteGuideNote(g)).toContain('follow it for every change');
    expect(siteGuideNote(g)).toContain('wins over it');
  });

  it('no guide, an empty one or a binary file: null, with how to start one', async () => {
    expect(await readSiteGuide(new MemorySiteFs({ 'index.html': 'x' }))).toBeNull();
    expect(await readSiteGuide(new MemorySiteFs({ [SITE_GUIDE]: '  \n' }))).toBeNull();
    expect(await readSiteGuide(new MemorySiteFs({ [SITE_GUIDE]: Buffer.from([1, 0, 2]) }))).toBeNull();
    expect(siteGuideInfo(null)).toMatchObject({ path: SITE_GUIDE, text: null });
    expect(siteGuideNote(null)).toContain('no guide yet');
  });

  it('caps a guide written outside AI Connect at 16 KB without cutting a character', async () => {
    const fs = new MemorySiteFs({ [SITE_GUIDE]: `${'a'.repeat(16 * 1024 - 1)}ñ and more` });
    const g = await readSiteGuide(fs);
    expect(g?.truncated).toBe(true);
    expect(g?.text).toBe('a'.repeat(16 * 1024 - 1));
    const info = siteGuideInfo(g);
    expect(info.truncated).toBe(true);
    expect(info.text).toContain('truncated at 16 KB');
  });

  it('converts MLSD and ISO times', () => {
    expect(isoTime('20261029184501')).toBe('2026-10-29T18:45:01.000Z');
    expect(isoTime('20261029184501.250')).toBe('2026-10-29T18:45:01.250Z');
    expect(isoTime('2026-10-29T18:45:01Z')).toBe('2026-10-29T18:45:01.000Z');
    expect(isoTime('')).toBeNull();
    expect(isoTime('draft')).toBeNull();
  });
});

describe('site guide through drafts', () => {
  const SITE = 'site-1';
  let fs: MemorySiteFs;
  let core: DeployCore;
  beforeEach(() => {
    fs = new MemorySiteFs({ 'index.html': 'x', '.env': 'KEY=1' });
    core = new DeployCore({ drafts: new MemoryDraftStore(), releases: new MemoryReleaseStore(), blobs: new MemoryBlobStore() });
  });

  it('is readable, writable, published and revertible like a page', async () => {
    const d = await core.startDraft(SITE, fs);
    expect(await core.writeFiles(d.id, SITE, fs, [{ path: SITE_GUIDE, content: b('- Eventos nuevos arriba.') }])).toEqual([{ path: SITE_GUIDE, ok: true }]);
    expect((await core.readFile(SITE, fs, SITE_GUIDE, d.id)).text).toBe('- Eventos nuevos arriba.');
    await core.preview(d.id, SITE, fs);
    const rel = await core.publish(d.id, SITE, fs, 'test');
    expect(fs.text(SITE_GUIDE)).toBe('- Eventos nuevos arriba.');
    const live = await core.readFile(SITE, fs, SITE_GUIDE);
    expect(live.secret).toBeUndefined();
    expect(live.text).toBe('- Eventos nuevos arriba.');
    await core.revert(SITE, fs, rel.number, 'test');
    expect(fs.files.has(SITE_GUIDE)).toBe(false);
  });

  it('refuses a guide that is too big or not text, and every other dot-file stays secret', async () => {
    const d = await core.startDraft(SITE, fs);
    const res = await core.writeFiles(d.id, SITE, fs, [
      { path: SITE_GUIDE, content: Buffer.alloc(16 * 1024 + 1, 'a') },
      { path: SITE_GUIDE, content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]) },
      { path: '.env', content: b('KEY=2') },
      { path: 'blog/.htcrservers-guide.md', content: b('x') },
    ]);
    expect(res.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(res[0]!.error).toContain('16 KB');
    expect(res[1]!.error).toContain('plain text');
    expect((await core.readFile(SITE, fs, '.env')).secret).toBe(true);
  });
});
