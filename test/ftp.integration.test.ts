import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error ftp-srv ships no types we rely on
import { FtpSrv } from 'ftp-srv';
import { DeployCore } from '../src/deploy/core.js';
import { FtpSiteFs } from '../src/deploy/ftpfs.js';
import { MemoryBlobStore, MemoryDraftStore, MemoryReleaseStore } from '../src/deploy/stores.js';

/**
 * Real FTP round trip against a local ftp-srv (plain FTP; TLS is covered by spike 0c on a
 * live node). Exercises the exact operations the deploy core uses.
 */
let root: string;
let server: { listen(): Promise<unknown>; close(): Promise<unknown>; on(e: string, cb: (...a: any[]) => void): void };
let port: number;
const noop = () => undefined;
const quietLog: Record<string, unknown> = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
quietLog.child = () => quietLog;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'crs-ftp-'));
  writeFileSync(join(root, 'index.html'), '<h1>v1</h1>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'a.css'), 'a{}');
  port = 20000 + Math.floor(Math.random() * 20000);
  server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: port + 1, pasv_max: port + 50, anonymous: false, greeting: 'test', log: quietLog });
  server.on('login', ({ username, password }: { username: string; password: string }, resolve: (o: { root: string }) => void, reject: (e: Error) => void) => {
    if (username === 'deploy' && password === 'pw') resolve({ root });
    else reject(new Error('bad login'));
  });
  await server.listen();
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const site = () => new FtpSiteFs({ host: '127.0.0.1', port, user: 'deploy', password: 'pw', secure: false });

describe('FtpSiteFs', () => {
  it('lists, walks, stats and reads', async () => {
    const fs = site();
    try {
      expect((await fs.list('')).map((e) => [e.path, e.type])).toEqual([['assets', 'dir'], ['index.html', 'file']]);
      expect((await fs.walk()).map((e) => e.path)).toEqual(['assets/a.css', 'index.html']);
      expect(await fs.stat('index.html')).toMatchObject({ type: 'file', size: 11 });
      expect(await fs.stat('missing.html')).toBeNull();
      expect(await fs.stat('nodir/x.html')).toBeNull();
      expect((await fs.read('assets/a.css')).toString()).toBe('a{}');
    } finally {
      await fs.close();
    }
  });

  it('writes with parent dirs, renames over an existing file, removes', async () => {
    const fs = site();
    try {
      await fs.write('deep/er/page.html', Buffer.from('p'));
      expect(readFileSync(join(root, 'deep/er/page.html'), 'utf8')).toBe('p');
      await fs.write('deep/er/.tmp-x', Buffer.from('p2'));
      await fs.rename('deep/er/.tmp-x', 'deep/er/page.html');
      expect(readFileSync(join(root, 'deep/er/page.html'), 'utf8')).toBe('p2');
      await fs.remove('deep/er/page.html');
      expect(existsSync(join(root, 'deep/er/page.html'))).toBe(false);
    } finally {
      await fs.close();
    }
  });

  it('runs a full publish and revert through the deploy core', async () => {
    const fs = site();
    const core = new DeployCore({ drafts: new MemoryDraftStore(), releases: new MemoryReleaseStore(), blobs: new MemoryBlobStore() });
    try {
      const d = await core.startDraft('s', fs);
      await core.writeFiles(d.id, 's', fs, [
        { path: 'index.html', content: Buffer.from('<h1>v2</h1>') },
        { path: 'img/new.svg', content: Buffer.from('<svg/>') },
      ]);
      await core.deleteFiles(d.id, 's', fs, ['assets/a.css']);
      await core.preview(d.id, 's', fs);
      const rel = await core.publish(d.id, 's', fs, 'test');
      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<h1>v2</h1>');
      expect(readFileSync(join(root, 'img/new.svg'), 'utf8')).toBe('<svg/>');
      expect(existsSync(join(root, 'assets/a.css'))).toBe(false);
      expect((await fs.walk()).some((e) => e.path.includes('.crs-tmp-'))).toBe(false);

      await core.revert('s', fs, rel.number, 'test');
      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<h1>v1</h1>');
      expect(existsSync(join(root, 'img/new.svg'))).toBe(false);
      expect(readFileSync(join(root, 'assets/a.css'), 'utf8')).toBe('a{}');
    } finally {
      await fs.close();
    }
  });
});
