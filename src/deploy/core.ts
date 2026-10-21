import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { MB, assertWritable, isTextPath, maxFileBytes, normalizeSiteDir, normalizeSitePath } from './paths.js';
import { baseOf, dirOf, type SiteEntry, type SiteFs } from './sitefs.js';
import type { BlobStore, Draft, DraftStore, Release, ReleaseFile, ReleaseStore } from './stores.js';

/**
 * Deploy core (docs/ARCHITECTURE.md, "Publishing"): drafts, preview gate, conflict check, revert records,
 * two-phase publish with rollback, and revert. Transport-agnostic: callers pass the
 * site's SiteFs.
 */

export type DeployErrorCode =
  | 'not_found'
  | 'expired'
  | 'invalid'
  | 'limit'
  | 'not_previewed'
  | 'conflict'
  | 'drift'
  | 'not_revertible'
  | 'publish_failed';

export class DeployError extends Error {
  constructor(
    readonly code: DeployErrorCode,
    message: string,
    readonly paths: string[] = [],
  ) {
    super(message);
    this.name = 'DeployError';
  }
}

export interface DeployCoreOptions {
  drafts: DraftStore;
  releases: ReleaseStore;
  blobs: BlobStore;
  /** Releases kept with revert records per site (default 5). */
  keepReleases?: number;
  draftTtlMs?: number;
  maxDraftBytes?: number;
  maxDraftFiles?: number;
  now?: () => Date;
}

export interface FileInput {
  path: string;
  content: Buffer;
  /** Hash the AI based its change on (from read_file); overrides the recorded base. */
  baseHash?: string;
}

export interface ReadResult {
  path: string;
  size: number;
  hash: string;
  /** Present for text files up to 1 MB. */
  text?: string;
}

export interface PreviewSummary {
  added: string[];
  modified: string[];
  deleted: string[];
  conflicts: string[];
}

const READ_TEXT_LIMIT = 1 * MB;

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function fingerprint(e: SiteEntry): string {
  return `${e.size}:${e.modified}`;
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export class DeployCore {
  private readonly drafts: DraftStore;
  private readonly releases: ReleaseStore;
  private readonly blobs: BlobStore;
  private readonly keepReleases: number;
  private readonly draftTtlMs: number;
  private readonly maxDraftBytes: number;
  private readonly maxDraftFiles: number;
  private readonly now: () => Date;
  private readonly siteLocks = new Map<string, Promise<unknown>>();

  constructor(opts: DeployCoreOptions) {
    this.drafts = opts.drafts;
    this.releases = opts.releases;
    this.blobs = opts.blobs;
    this.keepReleases = opts.keepReleases ?? 5;
    this.draftTtlMs = opts.draftTtlMs ?? 24 * 3600 * 1000;
    this.maxDraftBytes = opts.maxDraftBytes ?? 200 * MB;
    this.maxDraftFiles = opts.maxDraftFiles ?? 2000;
    this.now = opts.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- drafts

  async startDraft(siteId: string, fs: SiteFs, note = ''): Promise<Draft> {
    const live = await fs.walk();
    const now = this.now();
    const draft: Draft = {
      id: randomUUID(),
      siteId,
      note: note.slice(0, 500),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.draftTtlMs),
      version: 0,
      previewedVersion: null,
      writes: new Map(),
      deletes: new Set(),
      base: new Map(),
      startFingerprints: new Map(live.map((e) => [e.path, fingerprint(e)])),
      earlyConflicts: new Set(),
    };
    await this.drafts.put(draft);
    return draft;
  }

  /** Which site a draft belongs to (undefined when unknown). Callers still pass that site to every method. */
  async draftSiteId(draftId: string): Promise<string | undefined> {
    return this.drafts.siteOf(draftId);
  }

  async getDraft(draftId: string, siteId: string): Promise<Draft> {
    const d = await this.drafts.get(draftId);
    if (!d || d.siteId !== siteId) throw new DeployError('not_found', 'Draft not found');
    if (d.expiresAt <= this.now()) {
      await this.drafts.delete(d.id);
      throw new DeployError('expired', 'Draft expired; start a new one');
    }
    return d;
  }

  async discardDraft(draftId: string, siteId: string): Promise<void> {
    await this.getDraft(draftId, siteId);
    await this.drafts.delete(draftId);
  }

  /** Records the base of a path the first time the draft touches it (conflict check). */
  private async touch(d: Draft, fs: SiteFs, path: string, baseHash?: string): Promise<void> {
    if (d.base.has(path)) return;
    const st = await fs.stat(path);
    const startFp = d.startFingerprints.get(path);
    const nowFp = st ? fingerprint(st) : undefined;
    if (startFp !== nowFp) d.earlyConflicts.add(path);
    if (baseHash !== undefined) d.base.set(path, baseHash || null);
    else d.base.set(path, st ? sha256(await fs.read(path)) : null);
  }

  private draftBytes(d: Draft): number {
    let n = 0;
    for (const b of d.writes.values()) n += b.length;
    return n;
  }

  async writeFiles(draftId: string, siteId: string, fs: SiteFs, files: FileInput[]): Promise<{ path: string; ok: boolean; error?: string }[]> {
    const d = await this.getDraft(draftId, siteId);
    const results: { path: string; ok: boolean; error?: string }[] = [];
    for (const f of files) {
      let path = f.path;
      try {
        path = normalizeSitePath(f.path);
        assertWritable(path);
        if (f.content.length > maxFileBytes(path)) throw new DeployError('limit', `File too large (max ${maxFileBytes(path) / MB} MB)`);
        const prev = d.writes.get(path)?.length ?? 0;
        if (this.draftBytes(d) - prev + f.content.length > this.maxDraftBytes) throw new DeployError('limit', 'Draft size limit reached');
        if (!d.writes.has(path) && !d.deletes.has(path) && d.base.size >= this.maxDraftFiles) throw new DeployError('limit', 'Draft file count limit reached');
        await this.touch(d, fs, path, f.baseHash);
        d.writes.set(path, f.content);
        d.deletes.delete(path);
        results.push({ path, ok: true });
      } catch (e) {
        results.push({ path, ok: false, error: (e as Error).message });
      }
    }
    if (results.some((r) => r.ok)) d.version++;
    await this.drafts.put(d);
    return results;
  }

  async deleteFiles(draftId: string, siteId: string, fs: SiteFs, paths: string[]): Promise<{ path: string; ok: boolean; error?: string }[]> {
    const d = await this.getDraft(draftId, siteId);
    const results: { path: string; ok: boolean; error?: string }[] = [];
    for (const raw of paths) {
      let path = raw;
      try {
        path = normalizeSitePath(raw);
        assertWritable(path);
        const existsLive = (await fs.stat(path)) !== null;
        if (!existsLive && !d.writes.has(path)) throw new DeployError('not_found', 'File does not exist');
        await this.touch(d, fs, path);
        d.writes.delete(path);
        if (existsLive) d.deletes.add(path);
        results.push({ path, ok: true });
      } catch (e) {
        results.push({ path, ok: false, error: (e as Error).message });
      }
    }
    if (results.some((r) => r.ok)) d.version++;
    await this.drafts.put(d);
    return results;
  }

  // ---------------------------------------------------------------- reads (no side effects)

  async readFile(siteId: string, fs: SiteFs, rawPath: string, draftId?: string): Promise<ReadResult> {
    const path = normalizeSitePath(rawPath);
    let data: Buffer | undefined;
    if (draftId) {
      const d = await this.getDraft(draftId, siteId);
      if (d.deletes.has(path)) throw new DeployError('not_found', 'File is deleted in this draft');
      data = d.writes.get(path);
    }
    if (!data) {
      if (!(await fs.stat(path))) throw new DeployError('not_found', 'File not found');
      data = await fs.read(path);
    }
    const result: ReadResult = { path, size: data.length, hash: sha256(data) };
    if (isTextPath(path) && data.length <= READ_TEXT_LIMIT) result.text = data.toString('utf8');
    return result;
  }

  async listFiles(siteId: string, fs: SiteFs, rawDir?: string, draftId?: string): Promise<SiteEntry[]> {
    const dir = normalizeSiteDir(rawDir);
    const live = await this.listLiveDir(fs, dir);
    const entries = new Map((live ?? []).map((e) => [e.path, e]));
    if (draftId) {
      const d = await this.getDraft(draftId, siteId);
      for (const p of d.deletes) entries.delete(p);
      for (const [p, data] of d.writes) {
        if (dirOf(p) === dir) entries.set(p, { path: p, type: 'file', size: data.length, modified: 'draft' });
        else if (p.startsWith(dir ? `${dir}/` : '')) {
          const rest = p.slice(dir ? dir.length + 1 : 0);
          const sub = joinPath(dir, rest.slice(0, rest.indexOf('/')));
          if (!entries.has(sub)) entries.set(sub, { path: sub, type: 'dir', size: 0, modified: '' });
        }
      }
    }
    // A folder that exists neither live nor in the draft: say so instead of an internal error,
    // so the assistant corrects the path rather than retrying it.
    if (!live && !entries.size) throw new DeployError('not_found', 'Folder not found');
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Live entries of a folder, or null when the folder doesn't exist (FTP refuses the listing). */
  private async listLiveDir(fs: SiteFs, dir: string): Promise<SiteEntry[] | null> {
    let list: SiteEntry[];
    try {
      list = await fs.list(dir);
    } catch (e) {
      if (dir && !(await this.dirExists(fs, dir))) return null;
      throw e;
    }
    if (!list.length && dir && !(await this.dirExists(fs, dir))) return null;
    return list;
  }

  /** Decided from the nearest ancestor that lists; a failure that isn't a missing folder propagates. */
  private async dirExists(fs: SiteFs, dir: string): Promise<boolean> {
    const parent = dirOf(dir);
    let list: SiteEntry[];
    try {
      list = await fs.list(parent);
    } catch (e) {
      if (parent && !(await this.dirExists(fs, parent))) return false;
      throw e;
    }
    return list.some((e) => e.path === dir && e.type === 'dir');
  }

  // ---------------------------------------------------------------- preview / publish

  private async conflicts(d: Draft, fs: SiteFs): Promise<{ conflicts: string[]; live: Map<string, Buffer | null> }> {
    const conflicts = new Set(d.earlyConflicts);
    const live = new Map<string, Buffer | null>();
    for (const [path, base] of d.base) {
      const st = await fs.stat(path);
      const cur = st ? await fs.read(path) : null;
      live.set(path, cur);
      if ((cur ? sha256(cur) : null) !== base) conflicts.add(path);
    }
    return { conflicts: [...conflicts].sort(), live };
  }

  /** What a draft changes, without side effects (approval rules look at this before publishing). */
  async summary(draftId: string, siteId: string): Promise<{ added: string[]; modified: string[]; deleted: string[]; version: number; previewed: boolean; expiresAt: Date }> {
    const d = await this.getDraft(draftId, siteId);
    const added: string[] = [];
    const modified: string[] = [];
    for (const p of d.writes.keys()) (d.base.get(p) === null ? added : modified).push(p);
    return { added: added.sort(), modified: modified.sort(), deleted: [...d.deletes].sort(), version: d.version, previewed: d.previewedVersion === d.version, expiresAt: d.expiresAt };
  }

  /** Marks the current draft version as previewed. Scans and the preview site are added by callers. */
  async preview(draftId: string, siteId: string, fs: SiteFs): Promise<PreviewSummary> {
    const d = await this.getDraft(draftId, siteId);
    const { conflicts } = await this.conflicts(d, fs);
    const added: string[] = [];
    const modified: string[] = [];
    for (const p of d.writes.keys()) (d.base.get(p) === null ? added : modified).push(p);
    d.previewedVersion = d.version;
    await this.drafts.put(d);
    return { added: added.sort(), modified: modified.sort(), deleted: [...d.deletes].sort(), conflicts };
  }

  /** `expectedVersion`: refuse unless the draft is still exactly that version (approval link). */
  async publish(draftId: string, siteId: string, fs: SiteFs, byApp: string, expectedVersion?: number): Promise<Release> {
    return this.withSiteLock(siteId, async () => {
      const d = await this.getDraft(draftId, siteId);
      if (expectedVersion !== undefined && d.version !== expectedVersion) throw new DeployError('not_previewed', 'The draft changed after approval was requested');
      if (d.writes.size === 0 && d.deletes.size === 0) throw new DeployError('invalid', 'Nothing to publish');
      if (d.previewedVersion !== d.version) throw new DeployError('not_previewed', 'Preview the draft in its current form before publishing');
      const { conflicts, live } = await this.conflicts(d, fs);
      if (conflicts.length) throw new DeployError('conflict', 'The live site changed since the draft read these files', conflicts);
      const release = await this.commit(siteId, fs, d.writes, d.deletes, live, 'publish', byApp);
      await this.drafts.delete(d.id);
      return release;
    });
  }

  async listReleases(siteId: string): Promise<Release[]> {
    return this.releases.list(siteId);
  }

  /** Restores the files as they were before release `number`, undoing it and every later release. */
  async revert(siteId: string, fs: SiteFs, number: number, byApp: string): Promise<Release> {
    return this.withSiteLock(siteId, async () => {
      const rels = await this.releases.list(siteId);
      const idx = rels.findIndex((r) => r.number === number);
      if (idx < 0) throw new DeployError('not_revertible', `Release #${number} is not in the revert history (last ${this.keepReleases} are kept)`);
      const affected = rels.slice(0, idx + 1); // newest .. target

      const expected = new Map<string, string | null>(); // what should be live now
      for (const r of affected) for (const f of r.files) if (!expected.has(f.path)) expected.set(f.path, f.afterHash);
      const target = new Map<string, ReleaseFile>(); // state before the target release
      for (const r of [...affected].reverse()) for (const f of r.files) if (!target.has(f.path)) target.set(f.path, f);

      const live = new Map<string, Buffer | null>();
      const drift: string[] = [];
      for (const [path, want] of expected) {
        const st = await fs.stat(path);
        const cur = st ? await fs.read(path) : null;
        live.set(path, cur);
        if ((cur ? sha256(cur) : null) !== want) drift.push(path);
      }
      if (drift.length) throw new DeployError('drift', 'These files were changed outside the connector since; revert refused', drift.sort());

      const writes = new Map<string, Buffer>();
      const deletes = new Set<string>();
      for (const [path, f] of target) {
        if (f.beforeBlob) writes.set(path, await this.blobs.get(f.beforeBlob));
        else deletes.add(path);
      }
      return this.commit(siteId, fs, writes, deletes, live, 'revert', byApp);
    });
  }

  // ---------------------------------------------------------------- internals

  /**
   * Saves the revert record, applies the change in two phases and records the release.
   * Phase 1 uploads to temporary names (failure = nothing live changed). Phase 2 renames
   * into place and deletes last; on failure the already-applied paths are restored.
   */
  private async commit(
    siteId: string,
    fs: SiteFs,
    writes: Map<string, Buffer>,
    deletes: Set<string>,
    live: Map<string, Buffer | null>,
    cause: Release['cause'],
    byApp: string,
  ): Promise<Release> {
    const releaseId = randomUUID();
    const files: ReleaseFile[] = [];
    const touched = [...new Set([...writes.keys(), ...deletes])].sort();
    for (const [i, path] of touched.entries()) {
      const before = live.has(path) ? live.get(path)! : (await fs.stat(path)) ? await fs.read(path) : null;
      let beforeBlob: string | null = null;
      if (before) {
        beforeBlob = `${siteId}/${releaseId}/${i}`;
        await this.blobs.put(beforeBlob, before);
      }
      const after = writes.get(path);
      files.push({ path, beforeHash: before ? sha256(before) : null, beforeBlob, afterHash: after ? sha256(after) : null });
    }

    // Phase 1: temporary uploads.
    const temps: [tmp: string, path: string][] = [];
    try {
      for (const [path, data] of writes) {
        const tmp = joinPath(dirOf(path), `.crs-tmp-${randomBytes(6).toString('hex')}-${baseOf(path)}`);
        await fs.write(tmp, data);
        temps.push([tmp, path]);
      }
    } catch (e) {
      await this.removeQuietly(fs, temps.map(([t]) => t));
      await this.deleteBlobs(files);
      throw new DeployError('publish_failed', `Upload failed; nothing on the live site changed (${(e as Error).message})`);
    }

    // Phase 2: rename into place, delete last.
    const applied: string[] = [];
    try {
      for (const [tmp, path] of temps) {
        await fs.rename(tmp, path);
        applied.push(path);
      }
      for (const path of deletes) {
        if (await fs.stat(path)) await fs.remove(path);
        applied.push(path);
      }
    } catch (e) {
      const restoreErrors = await this.restore(fs, files.filter((f) => applied.includes(f.path)));
      await this.removeQuietly(fs, temps.filter(([, p]) => !applied.includes(p)).map(([t]) => t));
      await this.deleteBlobs(files);
      const tail = restoreErrors.length ? ` Restore failed for: ${restoreErrors.join(', ')}` : ' Changes already applied were rolled back.';
      throw new DeployError('publish_failed', `Publish failed (${(e as Error).message}).${tail}`, restoreErrors);
    }

    const latest = (await this.releases.list(siteId))[0];
    const release: Release = { id: releaseId, siteId, number: (latest?.number ?? 0) + 1, createdAt: this.now(), cause, byApp, files };
    await this.releases.add(release);
    for (const old of await this.releases.prune(siteId, this.keepReleases)) await this.deleteBlobs(old.files);
    return release;
  }

  private async restore(fs: SiteFs, files: ReleaseFile[]): Promise<string[]> {
    const failed: string[] = [];
    for (const f of files) {
      try {
        if (f.beforeBlob) await fs.write(f.path, await this.blobs.get(f.beforeBlob));
        else if (await fs.stat(f.path)) await fs.remove(f.path);
      } catch {
        failed.push(f.path);
      }
    }
    return failed;
  }

  private async removeQuietly(fs: SiteFs, paths: string[]): Promise<void> {
    for (const p of paths) await fs.remove(p).catch(() => undefined);
  }

  private async deleteBlobs(files: ReleaseFile[]): Promise<void> {
    for (const f of files) if (f.beforeBlob) await this.blobs.delete(f.beforeBlob).catch(() => undefined);
  }

  /** One publish or revert at a time per site. Single-process lock; Postgres advisory lock later. */
  private async withSiteLock<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.siteLocks.get(siteId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.siteLocks.set(siteId, run.catch(() => undefined));
    return run;
  }
}
