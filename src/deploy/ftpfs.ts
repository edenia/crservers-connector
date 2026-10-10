import { Readable, Writable } from 'node:stream';
import { Client, FileType, type FileInfo } from 'basic-ftp';
import { baseOf, dirOf, type SiteEntry, type SiteFs } from './sitefs.js';

/**
 * SiteFs over FTP(S) to a deploy user jailed to the site's web root (SPEC §6, decision 3;
 * spike 0c). The jail root "/" is the web root, so site paths map to "/<path>".
 *
 * Production: explicit TLS to the node hostname with certificate verification
 * (ProFTPd serves one node-wide certificate, so connect by node hostname, not the domain).
 */
export interface FtpSiteConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  /** true = explicit FTPS (production). false only for local tests. */
  secure: boolean;
  /** Only for tests with a self-signed server. */
  allowSelfSigned?: boolean;
  timeoutMs?: number;
}

const abs = (path: string) => `/${path}`;

export class FtpSiteFs implements SiteFs {
  private client: Client | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: FtpSiteConfig) {}

  /** basic-ftp is strictly sequential per connection; serialize every operation. */
  private run<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(async () => fn(await this.connect()));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async connect(): Promise<Client> {
    if (this.client && !this.client.closed) return this.client;
    const c = new Client(this.cfg.timeoutMs ?? 30_000);
    await c.access({
      host: this.cfg.host,
      port: this.cfg.port ?? 21,
      user: this.cfg.user,
      password: this.cfg.password,
      secure: this.cfg.secure,
      secureOptions: this.cfg.secure ? { servername: this.cfg.host, rejectUnauthorized: !this.cfg.allowSelfSigned } : undefined,
    });
    this.client = c;
    return c;
  }

  private toEntry(dir: string, f: FileInfo): SiteEntry | null {
    if (f.name === '.' || f.name === '..') return null;
    // Never follow or expose symlinks.
    if (f.type !== FileType.File && f.type !== FileType.Directory) return null;
    return {
      path: dir ? `${dir}/${f.name}` : f.name,
      type: f.type === FileType.Directory ? 'dir' : 'file',
      size: f.size,
      modified: f.rawModifiedAt || (f.modifiedAt ? f.modifiedAt.toISOString() : ''),
    };
  }

  list(dir: string): Promise<SiteEntry[]> {
    return this.run(async (c) => {
      const items = await c.list(dir ? abs(dir) : '/');
      return items
        .map((f) => this.toEntry(dir, f))
        .filter((e): e is SiteEntry => e !== null)
        .sort((a, b) => a.path.localeCompare(b.path));
    });
  }

  async walk(): Promise<SiteEntry[]> {
    const out: SiteEntry[] = [];
    const pending = [''];
    while (pending.length) {
      const dir = pending.pop()!;
      for (const e of await this.list(dir)) (e.type === 'dir' ? pending.push(e.path) : out.push(e));
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async stat(path: string): Promise<SiteEntry | null> {
    const parent = dirOf(path);
    let entries: SiteEntry[];
    try {
      entries = await this.list(parent);
    } catch {
      return null; // parent directory doesn't exist
    }
    const e = entries.find((x) => x.path === path);
    return e && e.type === 'file' ? e : null;
  }

  read(path: string): Promise<Buffer> {
    return this.run(async (c) => {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      await c.downloadTo(sink, abs(path));
      return Buffer.concat(chunks);
    });
  }

  write(path: string, data: Buffer): Promise<void> {
    return this.run(async (c) => {
      await this.mkdirp(c, dirOf(path));
      await c.uploadFrom(Readable.from([data]), abs(path));
    });
  }

  private async mkdirp(c: Client, dir: string): Promise<void> {
    if (!dir) return;
    let cur = '';
    for (const seg of dir.split('/')) {
      cur = cur ? `${cur}/${seg}` : seg;
      try {
        await c.send(`MKD ${abs(cur)}`);
      } catch {
        // Already exists (550). A real failure surfaces on the upload that follows.
      }
    }
  }

  rename(from: string, to: string): Promise<void> {
    return this.run(async (c) => {
      await c.rename(abs(from), abs(to));
    });
  }

  remove(path: string): Promise<void> {
    return this.run(async (c) => {
      await c.remove(abs(path));
    });
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    this.client?.close();
    this.client = null;
  }

  /** For logs: the file name only, never credentials. */
  toString(): string {
    return `FtpSiteFs(${this.cfg.user}@${this.cfg.host}, ${baseOf('/')})`;
  }
}
