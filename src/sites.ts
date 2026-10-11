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
  hbAccountId: number;
  domain: string;
  status: 'active' | 'frozen';
}

export class SiteRepo {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionKey: Buffer,
  ) {}

  async byAccount(hbAccountId: number): Promise<Site | undefined> {
    const r = await this.pool.query('SELECT id, hb_account_id, domain, status FROM sites WHERE hb_account_id = $1', [hbAccountId]);
    return r.rows[0] && toSite(r.rows[0]);
  }

  async byId(id: string): Promise<Site | undefined> {
    const r = await this.pool.query('SELECT id, hb_account_id, domain, status FROM sites WHERE id = $1', [id]);
    return r.rows[0] && toSite(r.rows[0]);
  }

  async add(input: { hbAccountId: number; domain: string; ftpHost: string; ftpUser: string; ftpPassword: string }): Promise<Site> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO sites (id, hb_account_id, domain, ftp_host, ftp_user, ftp_password_enc) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.hbAccountId, input.domain.toLowerCase(), input.ftpHost, input.ftpUser, seal(this.encryptionKey, input.ftpPassword)],
    );
    return { id, hbAccountId: input.hbAccountId, domain: input.domain.toLowerCase(), status: 'active' };
  }

  async ftpConfig(siteId: string): Promise<FtpSiteConfig> {
    const r = await this.pool.query('SELECT ftp_host, ftp_user, ftp_password_enc FROM sites WHERE id = $1', [siteId]);
    const row = r.rows[0];
    if (!row) throw new Error('Unknown site');
    return { host: row.ftp_host, user: row.ftp_user, password: open(this.encryptionKey, row.ftp_password_enc), secure: true };
  }
}

function toSite(row: { id: string; hb_account_id: number; domain: string; status: Site['status'] }): Site {
  return { id: row.id, hbAccountId: row.hb_account_id, domain: row.domain, status: row.status };
}
