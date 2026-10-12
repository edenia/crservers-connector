import { b64url, fromB64url, hmac, randomToken, safeEqual } from '../crypto.js';

/**
 * The signed `req` handed to the client-area extension (docs/ARCHITECTURE.md, "Sign-in").
 * The extension verifies it with the same construction:
 *   b64url(json{rid, app_name, app_host, exp, nonce[, purpose, service_id]}) "." b64url(HMAC-SHA256(key, <payload part>))
 * purpose "approve": the owner of service_id signs in to approve one publish (no consent screen).
 */
export interface ReqPayload {
  rid: string;
  app_name: string;
  app_host: string;
  /** Unix seconds. */
  exp: number;
  nonce: string;
  purpose?: 'approve';
  service_id?: number;
}

export function signReq(key: Buffer, p: Omit<ReqPayload, 'nonce'>): string {
  const payload: ReqPayload = { ...p, nonce: randomToken(12) };
  const part = b64url(Buffer.from(JSON.stringify(payload)));
  return `${part}.${b64url(hmac(key, part))}`;
}

/** Mirror of the plugin's check, used in tests. */
export function verifyReq(key: Buffer, req: string, nowSec = Math.floor(Date.now() / 1000)): ReqPayload | null {
  const [part, sig] = req.split('.');
  if (!part || !sig || !safeEqual(hmac(key, part), fromB64url(sig))) return null;
  const p = JSON.parse(fromB64url(part).toString('utf8')) as ReqPayload;
  return p.exp + 60 >= nowSec ? p : null;
}
