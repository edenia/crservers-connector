/**
 * Storage for drafts, releases and revert-record blobs. In-memory implementations for now;
 * Postgres (metadata) and an S3-compatible bucket (blobs) replace them in the next slice
 * behind the same interfaces.
 */

export interface Draft {
  id: string;
  siteId: string;
  note: string;
  createdAt: Date;
  expiresAt: Date;
  /** Incremented on every change; preview records which version it saw. */
  version: number;
  previewedVersion: number | null;
  /** Staged content per path. */
  writes: Map<string, Buffer>;
  deletes: Set<string>;
  /** Live content hash each touched path is based on (null = didn't exist). */
  base: Map<string, string | null>;
  /** Live modification hints captured when the draft started (path -> size:modified). */
  startFingerprints: Map<string, string>;
  /** Paths whose live copy changed between draft start and first touch. */
  earlyConflicts: Set<string>;
}

export interface ReleaseFile {
  path: string;
  /** Hash of the content before this release (null = didn't exist). */
  beforeHash: string | null;
  /** Blob key holding the content before this release (null = didn't exist). */
  beforeBlob: string | null;
  /** Hash of the content this release left live (null = deleted). */
  afterHash: string | null;
}

export interface Release {
  id: string;
  siteId: string;
  /** Sequential per site, shown to users ("versión #14"). */
  number: number;
  createdAt: Date;
  cause: 'publish' | 'revert';
  byApp: string;
  files: ReleaseFile[];
}

export interface DraftStore {
  get(id: string): Promise<Draft | undefined>;
  put(draft: Draft): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ReleaseStore {
  /** Newest first. */
  list(siteId: string): Promise<Release[]>;
  add(release: Release): Promise<void>;
  /** Keeps the newest `keep` releases and returns the removed ones (their blobs can go). */
  prune(siteId: string, keep: number): Promise<Release[]>;
}

export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, Draft>();
  async get(id: string) {
    return this.drafts.get(id);
  }
  async put(draft: Draft) {
    this.drafts.set(draft.id, draft);
  }
  async delete(id: string) {
    this.drafts.delete(id);
  }
}

export class MemoryReleaseStore implements ReleaseStore {
  private readonly bySite = new Map<string, Release[]>();
  async list(siteId: string) {
    return [...(this.bySite.get(siteId) ?? [])];
  }
  async add(release: Release) {
    const list = this.bySite.get(release.siteId) ?? [];
    list.unshift(release);
    this.bySite.set(release.siteId, list);
  }
  async prune(siteId: string, keep: number) {
    const list = this.bySite.get(siteId) ?? [];
    const removed = list.splice(keep);
    return removed;
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.blobs.set(key, Buffer.from(data));
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error(`blob not found: ${key}`);
    return Buffer.from(b);
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}
