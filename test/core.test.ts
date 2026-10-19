import { beforeEach, describe, expect, it } from 'vitest';
import { DeployCore, DeployError, sha256 } from '../src/deploy/core.js';
import { MemorySiteFs } from '../src/deploy/sitefs.js';
import { MemoryBlobStore, MemoryDraftStore, MemoryReleaseStore } from '../src/deploy/stores.js';

const SITE = 'site-1';
const b = (s: string) => Buffer.from(s);

let fs: MemorySiteFs;
let blobs: MemoryBlobStore;
let core: DeployCore;

beforeEach(() => {
  fs = new MemorySiteFs({ 'index.html': '<h1>v1</h1>', 'assets/a.css': 'a{}', 'old.html': 'old' });
  blobs = new MemoryBlobStore();
  core = new DeployCore({ drafts: new MemoryDraftStore(), releases: new MemoryReleaseStore(), blobs });
});

async function publishChange(change: (draftId: string) => Promise<unknown>) {
  const d = await core.startDraft(SITE, fs);
  await change(d.id);
  await core.preview(d.id, SITE, fs);
  return core.publish(d.id, SITE, fs, 'test');
}

const noTemps = () => [...fs.files.keys()].filter((p) => p.includes('.crs-tmp-'));

describe('drafts and reads', () => {
  it('stages changes without touching the live site', async () => {
    const d = await core.startDraft(SITE, fs);
    const res = await core.writeFiles(d.id, SITE, fs, [{ path: '/index.html', content: b('<h1>v2</h1>') }]);
    expect(res).toEqual([{ path: 'index.html', ok: true }]);
    expect(fs.text('index.html')).toBe('<h1>v1</h1>');
    expect((await core.readFile(SITE, fs, 'index.html', d.id)).text).toBe('<h1>v2</h1>');
    expect((await core.readFile(SITE, fs, 'index.html')).text).toBe('<h1>v1</h1>');
  });

  it('rejects disallowed paths per file and keeps the rest', async () => {
    const d = await core.startDraft(SITE, fs);
    const res = await core.writeFiles(d.id, SITE, fs, [
      { path: 'ok.html', content: b('x') },
      { path: 'evil.php', content: b('<?php') },
      { path: '../x.html', content: b('x') },
      { path: 'contact.php', content: b('x') },
    ]);
    expect(res.map((r) => r.ok)).toEqual([true, false, false, false]);
  });

  it('lists the draft view with staged additions and deletions', async () => {
    const d = await core.startDraft(SITE, fs);
    await core.writeFiles(d.id, SITE, fs, [{ path: 'new/page.html', content: b('n') }]);
    await core.deleteFiles(d.id, SITE, fs, ['old.html']);
    const paths = (await core.listFiles(SITE, fs, '', d.id)).map((e) => e.path);
    expect(paths).toEqual(['assets', 'index.html', 'new']);
  });

  it('read_file returns metadata only for binary files', async () => {
    fs.put('assets/img.jpg', Buffer.alloc(10, 1));
    const r = await core.readFile(SITE, fs, 'assets/img.jpg');
    expect(r.text).toBeUndefined();
    expect(r.hash).toBe(sha256(Buffer.alloc(10, 1)));
  });
});

describe('publish', () => {
  it('requires a preview of the current draft version', async () => {
    const d = await core.startDraft(SITE, fs);
    await core.writeFiles(d.id, SITE, fs, [{ path: 'index.html', content: b('v2') }]);
    await expect(core.publish(d.id, SITE, fs, 't')).rejects.toMatchObject({ code: 'not_previewed' });
    await core.preview(d.id, SITE, fs);
    await core.writeFiles(d.id, SITE, fs, [{ path: 'index.html', content: b('v3') }]);
    await expect(core.publish(d.id, SITE, fs, 't')).rejects.toMatchObject({ code: 'not_previewed' });
    await core.preview(d.id, SITE, fs);
    await expect(core.publish(d.id, SITE, fs, 't')).resolves.toMatchObject({ number: 1 });
    expect(fs.text('index.html')).toBe('v3');
  });

  it('applies writes and deletes, leaves no temp files, records a revert record', async () => {
    const rel = await publishChange(async (id) => {
      await core.writeFiles(id, SITE, fs, [
        { path: 'index.html', content: b('v2') },
        { path: 'new.html', content: b('new') },
      ]);
      await core.deleteFiles(id, SITE, fs, ['old.html']);
    });
    expect(fs.text('index.html')).toBe('v2');
    expect(fs.text('new.html')).toBe('new');
    expect(fs.files.has('old.html')).toBe(false);
    expect(noTemps()).toEqual([]);
    expect(rel.files.map((f) => [f.path, f.beforeHash !== null, f.afterHash !== null])).toEqual([
      ['index.html', true, true],
      ['new.html', false, true],
      ['old.html', true, false],
    ]);
  });

  it('refuses when the live file changed after the draft based on it', async () => {
    const d = await core.startDraft(SITE, fs);
    await core.writeFiles(d.id, SITE, fs, [{ path: 'index.html', content: b('mine') }]);
    fs.put('index.html', 'someone else via FTP');
    const summary = await core.preview(d.id, SITE, fs);
    expect(summary.conflicts).toEqual(['index.html']);
    await expect(core.publish(d.id, SITE, fs, 't')).rejects.toMatchObject({ code: 'conflict', paths: ['index.html'] });
    expect(fs.text('index.html')).toBe('someone else via FTP');
  });

  it('flags a change made between draft start and first touch', async () => {
    const d = await core.startDraft(SITE, fs);
    fs.put('index.html', 'changed after start');
    await core.writeFiles(d.id, SITE, fs, [{ path: 'index.html', content: b('mine') }]);
    expect((await core.preview(d.id, SITE, fs)).conflicts).toEqual(['index.html']);
  });

  it('honours base_hash from read_file', async () => {
    const before = await core.readFile(SITE, fs, 'index.html');
    fs.put('index.html', 'edited in between');
    const d = await core.startDraft(SITE, fs);
    await core.writeFiles(d.id, SITE, fs, [{ path: 'index.html', content: b('mine'), baseHash: before.hash }]);
    expect((await core.preview(d.id, SITE, fs)).conflicts).toEqual(['index.html']);
  });

  it('phase 1 failure: nothing live changes, temps cleaned', async () => {
    const d = await core.startDraft(SITE, fs);
    await core.writeFiles(d.id, SITE, fs, [
      { path: 'index.html', content: b('v2') },
      { path: 'z.html', content: b('z') },
    ]);
    await core.preview(d.id, SITE, fs);
    fs.failOn = (op, p) => op === 'write' && p.endsWith('-z.html');
    await expect(core.publish(d.id, SITE, fs, 't')).rejects.toMatchObject({ code: 'publish_failed' });
    expect(fs.text('index.html')).toBe('<h1>v1</h1>');
    expect(fs.files.has('z.html')).toBe(false);
    expect(noTemps()).toEqual([]);
    expect(await core.listReleases(SITE)).toEqual([]);
    expect(blobs.blobs.size).toBe(0);
  });

  it('phase 2 failure: already-applied paths are rolled back', async () => {
    const d = await core.startDraft(SITE, fs);
    await core.writeFiles(d.id, SITE, fs, [
      { path: 'index.html', content: b('v2') },
      { path: 'new.html', content: b('new') },
    ]);
    await core.deleteFiles(d.id, SITE, fs, ['old.html']);
    await core.preview(d.id, SITE, fs);
    fs.failOn = (op, p) => op === 'remove' && p === 'old.html';
    await expect(core.publish(d.id, SITE, fs, 't')).rejects.toMatchObject({ code: 'publish_failed' });
    fs.failOn = null;
    expect(fs.text('index.html')).toBe('<h1>v1</h1>');
    expect(fs.files.has('new.html')).toBe(false);
    expect(fs.text('old.html')).toBe('old');
    expect(noTemps()).toEqual([]);
  });

  it('serializes publishes per site', async () => {
    const d1 = await core.startDraft(SITE, fs);
    const d2 = await core.startDraft(SITE, fs);
    await core.writeFiles(d1.id, SITE, fs, [{ path: 'index.html', content: b('one') }]);
    await core.writeFiles(d2.id, SITE, fs, [{ path: 'index.html', content: b('two') }]);
    await core.preview(d1.id, SITE, fs);
    await core.preview(d2.id, SITE, fs);
    const results = await Promise.allSettled([core.publish(d1.id, SITE, fs, 'a'), core.publish(d2.id, SITE, fs, 'b')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' });
    expect(fs.text('index.html')).toBe('one');
  });
});

describe('revert', () => {
  it('restores the state before a release, and the revert itself can be undone', async () => {
    const r1 = await publishChange((id) => core.writeFiles(id, SITE, fs, [{ path: 'index.html', content: b('v2') }, { path: 'n.html', content: b('n') }]));
    await core.revert(SITE, fs, r1.number, 'test');
    expect(fs.text('index.html')).toBe('<h1>v1</h1>');
    expect(fs.files.has('n.html')).toBe(false);
    const releases = await core.listReleases(SITE);
    expect(releases.map((r) => [r.number, r.cause])).toEqual([[2, 'revert'], [1, 'publish']]);
    await core.revert(SITE, fs, 2, 'test');
    expect(fs.text('index.html')).toBe('v2');
    expect(fs.text('n.html')).toBe('n');
  });

  it('reverting an older release also undoes the later ones', async () => {
    const r1 = await publishChange((id) => core.writeFiles(id, SITE, fs, [{ path: 'index.html', content: b('v2') }]));
    await publishChange((id) => core.writeFiles(id, SITE, fs, [{ path: 'index.html', content: b('v3') }, { path: 'assets/a.css', content: b('b{}') }]));
    await core.revert(SITE, fs, r1.number, 'test');
    expect(fs.text('index.html')).toBe('<h1>v1</h1>');
    expect(fs.text('assets/a.css')).toBe('a{}');
  });

  it('refuses when files changed outside the connector since', async () => {
    const r1 = await publishChange((id) => core.writeFiles(id, SITE, fs, [{ path: 'index.html', content: b('v2') }]));
    fs.put('index.html', 'manual FTP edit');
    await expect(core.revert(SITE, fs, r1.number, 'test')).rejects.toMatchObject({ code: 'drift', paths: ['index.html'] });
    expect(fs.text('index.html')).toBe('manual FTP edit');
  });

  it('keeps only the last 5 releases and frees their blobs', async () => {
    for (let i = 2; i <= 8; i++) await publishChange((id) => core.writeFiles(id, SITE, fs, [{ path: 'index.html', content: b(`v${i}`) }]));
    const releases = await core.listReleases(SITE);
    expect(releases.map((r) => r.number)).toEqual([7, 6, 5, 4, 3]);
    expect(blobs.blobs.size).toBe(5);
    await expect(core.revert(SITE, fs, 2, 't')).rejects.toBeInstanceOf(DeployError);
  });
});
