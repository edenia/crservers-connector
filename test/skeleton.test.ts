import { beforeEach, describe, expect, it } from 'vitest';
import { DeployCore } from '../src/deploy/core.js';
import { matchesSkeleton } from '../src/deploy/skeleton.js';
import { MemorySiteFs } from '../src/deploy/sitefs.js';
import { MemoryBlobStore, MemoryDraftStore, MemoryReleaseStore } from '../src/deploy/stores.js';
import { fullSkeletonFiles, placeholderPage as page, skeletonFixture as fixture, skeletonFiles } from './fixtures/skeleton.js';

const SITE = 'site-1';
const b = (s: string) => Buffer.from(s);
let fs: MemorySiteFs;
let core: DeployCore;

beforeEach(() => {
  fs = new MemorySiteFs(skeletonFiles('cafe.example'));
  core = new DeployCore({ drafts: new MemoryDraftStore(), releases: new MemoryReleaseStore(), blobs: new MemoryBlobStore() });
});

describe('matching placeholder files', () => {
  it('matches the placeholder page for any domain, and nothing edited', () => {
    expect(matchesSkeleton('index.html', page('p2p-coffee.com'))).toBe(true);
    expect(matchesSkeleton('index.html.orig.bak-20260723', page('a.b.example.co.cr'))).toBe(true);
    expect(matchesSkeleton('index.html.orig', fixture('index.html'))).toBe(true); // "::DOMAIN::" never filled in
    expect(matchesSkeleton('index.html', Buffer.concat([page('p2p-coffee.com'), b('\n')]))).toBe(false);
    expect(matchesSkeleton('index.html', b(page('p2p-coffee.com').toString('latin1').replace('Sitio en preparación', 'Mi sitio')))).toBe(false);
    expect(matchesSkeleton('about.html', page('p2p-coffee.com'))).toBe(false);
    expect(matchesSkeleton('robots.txt', fixture('robots.txt'))).toBe(true);
    expect(matchesSkeleton('robots.txt', b('User-agent: *\nDisallow:\n'))).toBe(false);
    expect(matchesSkeleton('assets/robots.txt', fixture('robots.txt'))).toBe(false);
  });

  it('matches the page from before the 2026-10-28 skeleton update, also as its .bak copy', () => {
    const before = (domain: string) => Buffer.from(fixture('index-20261024.html').toString('latin1').split('::DOMAIN::').join(domain), 'latin1');
    expect(matchesSkeleton('index.html', before('p2p-coffee.com'))).toBe(true);
    expect(matchesSkeleton('index.html.bak-20261028-og', fixture('index-20261024.html'))).toBe(true);
    expect(matchesSkeleton('index.html.bak-20261028-og', page('p2p-coffee.com'))).toBe(true);
    expect(matchesSkeleton('index.html.bak-20261029', page('p2p-coffee.com'))).toBe(false);
  });
});

async function previewAndPublish(change: (id: string) => Promise<unknown>) {
  const d = await core.startDraft(SITE, fs);
  await change(d.id);
  const pv = await core.preview(d.id, SITE, fs);
  return { pv, rel: await core.publish(d.id, SITE, fs, 'test') };
}

describe('first publish on a fresh site', () => {
  it('removes the placeholder files with the new home page; revert brings them back', async () => {
    const before = new Map([...fs.files].map(([p, f]) => [p, f.data]));
    const { pv, rel } = await previewAndPublish((id) => core.writeFiles(id, SITE, fs, [{ path: 'index.html', content: b('<h1>Café</h1>') }, { path: 'style.css', content: b('a{}') }]));
    expect(pv.placeholders).toEqual(['crservers-logo.svg', 'index.html.orig', 'robots.txt']);
    expect(pv).toMatchObject({ added: ['style.css'], modified: ['index.html'], deleted: ['crservers-logo.svg', 'index.html.orig', 'robots.txt'], conflicts: [] });
    expect([...fs.files.keys()].sort()).toEqual(['index.html', 'style.css']);
    expect(rel.files.map((f) => f.path)).toEqual(['crservers-logo.svg', 'index.html', 'index.html.orig', 'robots.txt', 'style.css']);

    await core.revert(SITE, fs, rel.number, 'test');
    expect(new Map([...fs.files].map(([p, f]) => [p, f.data]))).toEqual(before);
  });

  it('also when the home page is index.htm, and ignores hidden files', async () => {
    fs.put('.well-known/acme-challenge/x', 'token');
    const { pv } = await previewAndPublish((id) => core.writeFiles(id, SITE, fs, [{ path: 'index.htm', content: b('<h1>Café</h1>') }]));
    expect(pv.placeholders).toEqual(['crservers-logo.svg', 'index.html', 'index.html.orig', 'robots.txt']);
    expect([...fs.files.keys()].sort()).toEqual(['.well-known/acme-challenge/x', 'index.htm']);
  });

  it('keeps a file the user chose to keep or write in the draft', async () => {
    const { pv } = await previewAndPublish((id) => core.writeFiles(id, SITE, fs, [{ path: 'index.html', content: b('<h1>Café</h1>') }, { path: 'robots.txt', content: b('User-agent: *\n') }]));
    expect(pv.placeholders).toEqual(['crservers-logo.svg', 'index.html.orig']);
    expect(fs.text('robots.txt')).toBe('User-agent: *\n');
  });

  it('a later preview recomputes: dropping the home page drops the cleanup', async () => {
    const d = await core.startDraft(SITE, fs);
    await core.writeFiles(d.id, SITE, fs, [{ path: 'index.html', content: b('<h1>Café</h1>') }, { path: 'a.html', content: b('a') }]);
    expect((await core.preview(d.id, SITE, fs)).placeholders).toHaveLength(3);
    await core.writeFiles(d.id, SITE, fs, [{ path: 'index.html', content: page('cafe.example') }]);
    const again = await core.preview(d.id, SITE, fs);
    expect(again.placeholders).toHaveLength(3); // a placeholder page written back is still the user's write
    await core.deleteFiles(d.id, SITE, fs, ['index.html']);
    const last = await core.preview(d.id, SITE, fs);
    expect(last).toMatchObject({ placeholders: [], deleted: ['index.html'] });
    await core.publish(d.id, SITE, fs, 'test');
    expect([...fs.files.keys()].sort()).toEqual(['a.html', 'crservers-logo.svg', 'index.html.orig', 'robots.txt']);
  });

  it('refuses to publish when a placeholder file changed after the preview', async () => {
    const d = await core.startDraft(SITE, fs);
    await core.writeFiles(d.id, SITE, fs, [{ path: 'index.html', content: b('<h1>Café</h1>') }]);
    await core.preview(d.id, SITE, fs);
    fs.put('robots.txt', 'User-agent: *\n');
    await expect(core.publish(d.id, SITE, fs, 'test')).rejects.toMatchObject({ code: 'conflict', paths: ['robots.txt'] });
  });
});

describe('the current skeleton', () => {
  it('a new account gets nothing but placeholders: all of it goes with the first home page', async () => {
    fs = new MemorySiteFs(fullSkeletonFiles('prosperacoffee.com'));
    const skeleton = [...fs.files.keys()].filter((p) => p !== 'index.html').sort();
    const { pv } = await previewAndPublish((id) => core.writeFiles(id, SITE, fs, [{ path: 'index.html', content: b('<h1>Café</h1>') }]));
    expect(skeleton).toHaveLength(14);
    expect(pv.placeholders).toEqual(skeleton);
    expect([...fs.files.keys()]).toEqual(['index.html']);
  });
});

describe('sites that are not fresh', () => {
  it('a customised index.html: nothing is removed', async () => {
    fs.put('index.html.orig', Buffer.concat([page('cafe.example'), b('<!-- edited -->')]));
    const { pv } = await previewAndPublish((id) => core.writeFiles(id, SITE, fs, [{ path: 'index.html', content: b('<h1>Café</h1>') }]));
    expect(pv).toMatchObject({ placeholders: [], deleted: [] });
    expect([...fs.files.keys()].sort()).toEqual(['crservers-logo.svg', 'index.html', 'index.html.orig', 'robots.txt']);
  });

  it('any other file on the site: nothing is removed', async () => {
    fs.put('old/page.html', 'customer page');
    const { pv } = await previewAndPublish((id) => core.writeFiles(id, SITE, fs, [{ path: 'index.html', content: b('<h1>Café</h1>') }]));
    expect(pv.placeholders).toEqual([]);
    expect(fs.files.has('robots.txt')).toBe(true);
  });

  it('a draft without a home page: nothing is removed', async () => {
    const { pv } = await previewAndPublish((id) => core.writeFiles(id, SITE, fs, [{ path: 'test.html', content: b('hola') }]));
    expect(pv.placeholders).toEqual([]);
    expect(fs.files.has('index.html')).toBe(true);
  });
});
