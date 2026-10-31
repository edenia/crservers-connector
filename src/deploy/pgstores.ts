import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { BlobStore, Draft, DraftStore, Release, ReleaseStore } from './stores.js';

/** Postgres-backed stores so drafts, releases and revert records survive restarts. */

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PgDraftStore implements DraftStore {
  constructor(private readonly pool: Pool) {}

  async siteOf(id: string): Promise<string | undefined> {
    if (!UUID_RE.test(id)) return undefined;
    return (await this.pool.query('SELECT site_id FROM drafts WHERE id = $1', [id])).rows[0]?.site_id;
  }

  async get(id: string): Promise<Draft | undefined> {
    const d = (await this.pool.query('SELECT * FROM drafts WHERE id = $1', [id])).rows[0];
    if (!d) return undefined;
    const files = (await this.pool.query('SELECT path, deleted, content FROM draft_files WHERE draft_id = $1', [id])).rows;
    return {
      id: d.id,
      siteId: d.site_id,
      note: d.note,
      createdAt: d.created_at,
      expiresAt: d.expires_at,
      version: d.version,
      previewedVersion: d.previewed_version,
      writes: new Map(files.filter((f) => !f.deleted).map((f) => [f.path, f.content as Buffer])),
      deletes: new Set(files.filter((f) => f.deleted).map((f) => f.path as string)),
      base: new Map(Object.entries(d.base as Record<string, string | null>)),
      startFingerprints: new Map(Object.entries(d.start_fingerprints as Record<string, string>)),
      earlyConflicts: new Set(d.early_conflicts as string[]),
      skeletonDeletes: new Set(d.skeleton_deletes as string[]),
    };
  }

  async put(draft: Draft): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO drafts (id, site_id, note, created_at, expires_at, version, previewed_version, base, start_fingerprints, early_conflicts, skeleton_deletes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, previewed_version = EXCLUDED.previewed_version,
           base = EXCLUDED.base, early_conflicts = EXCLUDED.early_conflicts, skeleton_deletes = EXCLUDED.skeleton_deletes`,
        [
          draft.id, draft.siteId, draft.note, draft.createdAt, draft.expiresAt, draft.version, draft.previewedVersion,
          JSON.stringify(Object.fromEntries(draft.base)), JSON.stringify(Object.fromEntries(draft.startFingerprints)), JSON.stringify([...draft.earlyConflicts]),
          JSON.stringify([...draft.skeletonDeletes]),
        ],
      );
      // Only rewrite files whose content changed (drafts can hold large media).
      const existing = new Map((await c.query('SELECT path, deleted, sha256 FROM draft_files WHERE draft_id = $1', [draft.id])).rows.map((r) => [r.path as string, r]));
      const keep = new Set<string>();
      for (const [path, content] of draft.writes) {
        keep.add(path);
        const h = sha(content);
        const cur = existing.get(path);
        if (cur && !cur.deleted && cur.sha256 === h) continue;
        await c.query(
          `INSERT INTO draft_files (draft_id, path, deleted, sha256, content) VALUES ($1, $2, false, $3, $4)
           ON CONFLICT (draft_id, path) DO UPDATE SET deleted = false, sha256 = EXCLUDED.sha256, content = EXCLUDED.content`,
          [draft.id, path, h, content],
        );
      }
      for (const path of draft.deletes) {
        keep.add(path);
        if (existing.get(path)?.deleted) continue;
        await c.query(
          `INSERT INTO draft_files (draft_id, path, deleted, sha256, content) VALUES ($1, $2, true, NULL, NULL)
           ON CONFLICT (draft_id, path) DO UPDATE SET deleted = true, sha256 = NULL, content = NULL`,
          [draft.id, path],
        );
      }
      const gone = [...existing.keys()].filter((p) => !keep.has(p));
      if (gone.length) await c.query('DELETE FROM draft_files WHERE draft_id = $1 AND path = ANY($2)', [draft.id, gone]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM drafts WHERE id = $1', [id]);
  }
}

export class PgReleaseStore implements ReleaseStore {
  constructor(private readonly pool: Pool) {}

  async list(siteId: string): Promise<Release[]> {
    const rows = (await this.pool.query('SELECT * FROM releases WHERE site_id = $1 ORDER BY number DESC', [siteId])).rows;
    return rows.map((r) => ({ id: r.id, siteId: r.site_id, number: r.number, createdAt: r.created_at, cause: r.cause, byApp: r.by_app, files: r.files }));
  }

  async add(r: Release): Promise<void> {
    await this.pool.query(
      'INSERT INTO releases (id, site_id, number, created_at, cause, by_app, files) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [r.id, r.siteId, r.number, r.createdAt, r.cause, r.byApp, JSON.stringify(r.files)],
    );
  }

  async prune(siteId: string, keep: number): Promise<Release[]> {
    const all = await this.list(siteId);
    const removed = all.slice(keep);
    if (removed.length) await this.pool.query('DELETE FROM releases WHERE id = ANY($1)', [removed.map((r) => r.id)]);
    return removed;
  }
}

export class PgBlobStore implements BlobStore {
  constructor(private readonly pool: Pool) {}

  async put(key: string, data: Buffer): Promise<void> {
    await this.pool.query('INSERT INTO blobs (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data', [key, data]);
  }

  async get(key: string): Promise<Buffer> {
    const r = (await this.pool.query('SELECT data FROM blobs WHERE key = $1', [key])).rows[0];
    if (!r) throw new Error(`blob not found: ${key}`);
    return r.data;
  }

  async delete(key: string): Promise<void> {
    await this.pool.query('DELETE FROM blobs WHERE key = $1', [key]);
  }
}

export interface AuditEvent {
  at: Date;
  clientId: string;
  action: string;
  detail: Record<string, unknown>;
}

export class AuditLog {
  constructor(private readonly pool: Pool) {}

  async add(siteId: string, clientId: string, action: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query('INSERT INTO audit_log (site_id, client_id, action, detail) VALUES ($1, $2, $3, $4)', [siteId, clientId, action, JSON.stringify(detail)]);
  }

  async recent(siteId: string, limit: number): Promise<AuditEvent[]> {
    const rows = (await this.pool.query('SELECT at, client_id, action, detail FROM audit_log WHERE site_id = $1 ORDER BY at DESC, id DESC LIMIT $2', [siteId, limit])).rows;
    return rows.map((r) => ({ at: r.at, clientId: r.client_id, action: r.action, detail: r.detail }));
  }
}
