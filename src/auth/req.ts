import { b64url, fromB64url, hmac, randomToken, safeEqual } from '../crypto.js';

/**
 * The signed `req` handed to the HostBill plugin (SPEC §5 "Login").
 * Format must match Crsconnect::verifyReq in edenia/hostbill-crsconnect:
 *   b64url(json{rid, app_name, app_host, exp, nonce}) "." b64url(HMAC-SHA256(key, <payload part>))
 */
export interface ReqPayload {
  rid: string;
  app_name: string;
  app_host: string;
  /** Unix seconds. */
  exp: number;
  nonce: string;
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
