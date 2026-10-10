/**
 * The only way the deploy core touches a site. Production uses FTPS (ftpfs.ts) with a
 * deploy user jailed to the web root; tests use MemorySiteFs.
 * Paths are normalized relative paths (see paths.ts); "" is the web root.
 */

export interface SiteEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
  /** Server modification time, as reported (MLSD `modify`). Used only as a cheap change hint. */
  modified: string;
}

export interface SiteFs {
  /** Direct children of a directory. */
  list(dir: string): Promise<SiteEntry[]>;
  /** Every file under the web root (no directories). */
  walk(): Promise<SiteEntry[]>;
  /** File metadata, or null when it doesn't exist. */
  stat(path: string): Promise<SiteEntry | null>;
  read(path: string): Promise<Buffer>;
  /** Writes a file, creating parent directories. */
  write(path: string, data: Buffer): Promise<void>;
  /** Renames a file, replacing the target if it exists. */
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  close(): Promise<void>;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** In-memory site for tests. `failOn` lets tests inject failures into specific operations. */
export class MemorySiteFs implements SiteFs {
  readonly files = new Map<string, { data: Buffer; modified: string }>();
  failOn: ((op: 'write' | 'rename' | 'remove' | 'read', path: string) => boolean) | null = null;
  private clock = 0;

  constructor(initial: Record<string, string | Buffer> = {}) {
    for (const [p, d] of Object.entries(initial)) this.put(p, d);
  }

  put(path: string, data: string | Buffer): void {
    this.files.set(path, { data: Buffer.from(data), modified: String(++this.clock).padStart(14, '0') });
  }

  text(path: string): string | undefined {
    return this.files.get(path)?.data.toString('utf8');
  }

  private check(op: 'write' | 'rename' | 'remove' | 'read', path: string): void {
    if (this.failOn?.(op, path)) throw new Error(`injected ${op} failure on ${path}`);
  }

  async list(dir: string): Promise<SiteEntry[]> {
    const prefix = dir ? `${dir}/` : '';
    const out = new Map<string, SiteEntry>();
    for (const [p, f] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) out.set(p, { path: p, type: 'file', size: f.data.length, modified: f.modified });
      else {
        const d = prefix + rest.slice(0, slash);
        if (!out.has(d)) out.set(d, { path: d, type: 'dir', size: 0, modified: '' });
      }
    }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async walk(): Promise<SiteEntry[]> {
    return [...this.files.entries()]
      .map(([path, f]) => ({ path, type: 'file' as const, size: f.data.length, modified: f.modified }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async stat(path: string): Promise<SiteEntry | null> {
    const f = this.files.get(path);
    return f ? { path, type: 'file', size: f.data.length, modified: f.modified } : null;
  }

  async read(path: string): Promise<Buffer> {
    this.check('read', path);
    const f = this.files.get(path);
    if (!f) throw new Error(`not found: ${path}`);
    return Buffer.from(f.data);
  }

  async write(path: string, data: Buffer): Promise<void> {
    this.check('write', path);
    this.put(path, data);
  }

  async rename(from: string, to: string): Promise<void> {
    this.check('rename', to);
    const f = this.files.get(from);
    if (!f) throw new Error(`not found: ${from}`);
    this.files.delete(from);
    this.files.set(to, { data: f.data, modified: String(++this.clock).padStart(14, '0') });
  }

  async remove(path: string): Promise<void> {
    this.check('remove', path);
    if (!this.files.delete(path)) throw new Error(`not found: ${path}`);
  }

  async close(): Promise<void> {}
}
