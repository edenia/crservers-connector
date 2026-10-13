import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { open, seal } from './crypto.js';
import type { FtpSiteConfig } from './deploy/ftpfs.js';

/**
 * Sites the connector can publish to. Pilot: registered by hand (scripts/site-add.ts) with
 * the deploy FTP user created in SiteWorx. Beta: a provisioning job.
 */
export interface Site {
  id: string;
  serviceId: number;
  domain: string;
  status: 'active' | 'frozen';
  /** The client asked to approve every publish in the browser ("Aprobar cada publicación"). */
  approveEveryPublish: boolean;
}

export class SiteRepo {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: Buffer,
  ) {}

  async byAccount(serviceId: number): Promise<Site | undefined> {
    const r = await this.pool.query('SELECT id, service_id, domain, status, approve_every_publish FROM sites WHERE service_id = $1', [serviceId]);
    return r.rows[0] && toSite(r.rows[0]);
  }

  async byId(id: string): Promise<Site | undefined> {
    const r = await this.pool.query('SELECT id, service_id, domain, status, approve_every_publish FROM sites WHERE id = $1', [id]);
    return r.rows[0] && toSite(r.rows[0]);
  }

  async add(input: { serviceId: number; domain: string; ftpHost: string; ftpUser: string; ftpPassword: string }): Promise<Site> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO sites (id, service_id, domain, ftp_host, ftp_user, ftp_password_enc) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.serviceId, input.domain.toLowerCase(), input.ftpHost, input.ftpUser, seal(this.encryptionKey, input.ftpPassword)],
    );
    return { id, serviceId: input.serviceId, domain: input.domain.toLowerCase(), status: 'active', approveEveryPublish: false };
  }

  /**
   * Automatic setup: registers the site, or replaces its deploy credentials when the client area
   * created or reset the deploy user. Leaves a frozen site frozen (the lifecycle events decide that).
   */
  async upsertSetup(input: { serviceId: number; domain: string; ftpHost: string; ftpUser: string; ftpPassword: string }): Promise<Site> {
    const r = await this.pool.query(
      `INSERT INTO sites (id, service_id, domain, ftp_host, ftp_user, ftp_password_enc) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (service_id) DO UPDATE SET domain = EXCLUDED.domain, ftp_host = EXCLUDED.ftp_host, ftp_user = EXCLUDED.ftp_user, ftp_password_enc = EXCLUDED.ftp_password_enc
       RETURNING id, service_id, domain, status, approve_every_publish`,
      [randomUUID(), input.serviceId, input.domain.toLowerCase(), input.ftpHost, input.ftpUser, seal(this.encryptionKey, input.ftpPassword)],
    );
    return toSite(r.rows[0]);
  }

  async setStatus(serviceId: number, status: Site['status']): Promise<Site | undefined> {
    const r = await this.pool.query('UPDATE sites SET status = $2 WHERE service_id = $1 RETURNING id, service_id, domain, status, approve_every_publish', [serviceId, status]);
    return r.rows[0] && toSite(r.rows[0]);
  }

  async ftpConfig(siteId: string): Promise<FtpSiteConfig> {
    const r = await this.pool.query('SELECT ftp_host, ftp_user, ftp_password_enc FROM sites WHERE id = $1', [siteId]);
    const row = r.rows[0];
    if (!row) throw new Error('Unknown site');
    return { host: row.ftp_host, user: row.ftp_user, password: open(this.encryptionKey, row.ftp_password_enc), secure: true };
  }
}

function toSite(row: { id: string; service_id: number; domain: string; status: Site['status']; approve_every_publish: boolean }): Site {
  return { id: row.id, serviceId: row.service_id, domain: row.domain, status: row.status, approveEveryPublish: row.approve_every_publish };
}
