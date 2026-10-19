import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { open, seal } from './crypto.js';
import type { FtpSiteConfig } from './deploy/ftpfs.js';

/**
 * Sites the connector can publish to: one per domain of a hosting service (main domain, secondary
 * domains and subdomains), each with its own jailed deploy FTP user. Registered by automatic site
 * setup on the first connection (src/auth/sitesetup.ts), or by hand (src/cli/site-add.ts).
 */
export type SiteKind = 'main' | 'secondary' | 'subdomain';

export interface Site {
  id: string;
  serviceId: number;
  domain: string;
  kind: SiteKind;
  status: 'active' | 'frozen';
  /** The client asked to approve every publish in the browser ("Aprobar cada publicación"). */
  approveEveryPublish: boolean;
  /** Folders of this site that hold other sites (a subdomain's files live inside its parent's folder). */
  protectedDirs: string[];
}

const COLS = 'id, service_id, domain, kind, status, approve_every_publish, protected_dirs';

export class SiteRepo {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: Buffer,
  ) {}

  /** One site of a service: the given domain, or the main domain when none is given. */
  async byAccount(serviceId: number, domain?: string): Promise<Site | undefined> {
    const r = domain
      ? await this.pool.query(`SELECT ${COLS} FROM sites WHERE service_id = $1 AND domain = $2`, [serviceId, domain.toLowerCase()])
      : await this.pool.query(`SELECT ${COLS} FROM sites WHERE service_id = $1 ORDER BY (kind = 'main') DESC, created_at LIMIT 1`, [serviceId]);
    return r.rows[0] && toSite(r.rows[0]);
  }

  /** Every site of a service. */
  async byService(serviceId: number): Promise<Site[]> {
    const r = await this.pool.query(`SELECT ${COLS} FROM sites WHERE service_id = $1 ORDER BY (kind = 'main') DESC, domain`, [serviceId]);
    return r.rows.map(toSite);
  }

  async byId(id: string): Promise<Site | undefined> {
    const r = await this.pool.query(`SELECT ${COLS} FROM sites WHERE id = $1`, [id]);
    return r.rows[0] && toSite(r.rows[0]);
  }

  async byIds(ids: string[]): Promise<Site[]> {
    if (!ids.length) return [];
    const r = await this.pool.query(`SELECT ${COLS} FROM sites WHERE id = ANY($1::uuid[]) ORDER BY domain`, [ids]);
    return r.rows.map(toSite);
  }

  async add(input: { serviceId: number; domain: string; ftpHost: string; ftpUser: string; ftpPassword: string; kind?: SiteKind }): Promise<Site> {
    const id = randomUUID();
    const r = await this.pool.query(
      `INSERT INTO sites (id, service_id, domain, kind, ftp_host, ftp_user, ftp_password_enc) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
      [id, input.serviceId, input.domain.toLowerCase(), input.kind ?? 'main', input.ftpHost, input.ftpUser, seal(this.encryptionKey, input.ftpPassword)],
    );
    return toSite(r.rows[0]);
  }

  /**
   * Automatic setup: registers the site, or replaces its deploy credentials when the client area
   * created or reset the deploy user. Leaves a frozen site frozen (the lifecycle events decide that).
   */
  async upsertSetup(input: { serviceId: number; domain: string; kind?: SiteKind; ftpHost: string; ftpUser: string; ftpPassword: string }): Promise<Site> {
    const r = await this.pool.query(
      `INSERT INTO sites (id, service_id, domain, kind, ftp_host, ftp_user, ftp_password_enc) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (service_id, domain) DO UPDATE SET kind = EXCLUDED.kind, ftp_host = EXCLUDED.ftp_host, ftp_user = EXCLUDED.ftp_user, ftp_password_enc = EXCLUDED.ftp_password_enc
       RETURNING ${COLS}`,
      [randomUUID(), input.serviceId, input.domain.toLowerCase(), input.kind ?? 'main', input.ftpHost, input.ftpUser, seal(this.encryptionKey, input.ftpPassword)],
    );
    return toSite(r.rows[0]);
  }

  /** The hosting layout as the client area saw it at this connection (subdomains can come and go). */
  async setLayout(siteId: string, kind: SiteKind, protectedDirs: string[]): Promise<void> {
    await this.pool.query('UPDATE sites SET kind = $2, protected_dirs = $3 WHERE id = $1', [siteId, kind, protectedDirs]);
  }

  /** Every site of the service (lifecycle events apply to the whole hosting service). */
  async setStatus(serviceId: number, status: Site['status']): Promise<Site[]> {
    const r = await this.pool.query(`UPDATE sites SET status = $2 WHERE service_id = $1 RETURNING ${COLS}`, [serviceId, status]);
    return r.rows.map(toSite);
  }

  async ftpConfig(siteId: string): Promise<FtpSiteConfig> {
    const r = await this.pool.query('SELECT ftp_host, ftp_user, ftp_password_enc FROM sites WHERE id = $1', [siteId]);
    const row = r.rows[0];
    if (!row) throw new Error('Unknown site');
    return { host: row.ftp_host, user: row.ftp_user, password: open(this.encryptionKey, row.ftp_password_enc), secure: true };
  }
}

type Row = { id: string; service_id: number; domain: string; kind: SiteKind; status: Site['status']; approve_every_publish: boolean; protected_dirs: string[] | null };

function toSite(row: Row): Site {
  return {
    id: row.id,
    serviceId: row.service_id,
    domain: row.domain,
    kind: row.kind,
    status: row.status,
    approveEveryPublish: row.approve_every_publish,
    protectedDirs: row.protected_dirs ?? [],
  };
}
