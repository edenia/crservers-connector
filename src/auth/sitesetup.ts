import { createDecipheriv, createHmac } from 'node:crypto';
import { fromB64url, hmac, safeEqual } from '../crypto.js';

/**
 * Automatic site setup (docs/ARCHITECTURE.md, "Automatic site setup"). The first time a client
 * connects a site, the client area creates the site's jailed FTP deploy user and hands its
 * credentials over once, inside the code exchange, sealed with a key derived from REQ_KEY:
 *   "v1." b64url(iv) "." b64url(ciphertext) "." b64url(tag)   (AES-256-GCM)
 * Deploy users are `crsconnect@<main domain>` for the main domain and `crsconnect<8 hex>@<main domain>`
 * for the service's other domains (each jailed to that domain's folder).
 * The client area also reports service lifecycle events (suspend, terminate…) to
 * POST /client-area/events, signed with REQ_KEY.
 */

export interface SiteSetup {
  ftpHost: string;
  ftpUser: string;
  ftpPassword: string;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function siteSetupKey(reqKey: Buffer): Buffer {
  return createHmac('sha256', reqKey).update('crsconnect site setup v1').digest();
}

/** Opens a sealed site setup, or throws. Validates the fields it will use to open FTPS connections. */
export function openSiteSetup(reqKey: Buffer, sealed: string): SiteSetup {
  const [v, iv, ct, tag] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct || !tag) throw new Error('Unknown site setup format');
  const d = createDecipheriv('aes-256-gcm', siteSetupKey(reqKey), fromB64url(iv));
  d.setAuthTag(fromB64url(tag));
  const j = JSON.parse(Buffer.concat([d.update(fromB64url(ct)), d.final()]).toString('utf8')) as Record<string, unknown>;
  const host = String(j.ftp_host ?? '').toLowerCase();
  const user = String(j.ftp_user ?? '');
  const password = String(j.ftp_password ?? '');
  if (!HOST_RE.test(host) || !/^crsconnect([0-9a-f]{8})?@[a-z0-9.-]+$/.test(user) || password.length < 16) throw new Error('Invalid site setup');
  return { ftpHost: host, ftpUser: user, ftpPassword: password };
}

export type ServiceEvent = 'suspend' | 'unsuspend' | 'terminate' | 'revoke';

export interface SignedEvent {
  serviceId: number;
  event: ServiceEvent;
  nonce: string;
}

const MAX_SKEW_S = 300;

/**
 * A signed request from the client area: X-Crs-Signature is HMAC-SHA256 of the raw body with
 * REQ_KEY; the body is JSON with `at` (unix seconds, ±5 min) and `nonce`. Returns the body or null.
 */
export function verifySigned(reqKey: Buffer, body: Buffer, signature: string, nowSec = Math.floor(Date.now() / 1000)): (Record<string, unknown> & { nonce: string }) | null {
  if (!signature || !safeEqual(hmac(reqKey, body.toString('utf8')), fromB64url(signature))) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const at = Number(j.at);
  if (!Number.isFinite(at) || Math.abs(nowSec - at) > MAX_SKEW_S) return null;
  if (typeof j.nonce !== 'string' || j.nonce.length < 8) return null;
  return j as Record<string, unknown> & { nonce: string };
}

/** Verifies a lifecycle event (see verifySigned). */
export function verifyEvent(reqKey: Buffer, body: Buffer, signature: string, nowSec = Math.floor(Date.now() / 1000)): SignedEvent | null {
  const j = verifySigned(reqKey, body, signature, nowSec);
  if (!j) return null;
  const event = j.event;
  if (event !== 'suspend' && event !== 'unsuspend' && event !== 'terminate' && event !== 'revoke') return null;
  const serviceId = Number(j.service_id);
  if (!Number.isInteger(serviceId) || serviceId <= 0) return null;
  return { serviceId, event, nonce: j.nonce };
}
