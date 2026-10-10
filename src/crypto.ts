import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const b64url = (buf: Buffer): string => buf.toString('base64url');
export const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

/** Random opaque token (tokens, codes, ids). 32 bytes by default. */
export const randomToken = (bytes = 32): string => b64url(randomBytes(bytes));

/** Tokens and codes are stored only as SHA-256 hashes. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** AES-256-GCM: returns "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key.subarray(0, 32), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', b64url(iv), b64url(c.getAuthTag()), b64url(ct)].join('.');
}

export function open(key: Buffer, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported sealed value');
  const d = createDecipheriv('aes-256-gcm', key.subarray(0, 32), fromB64url(iv));
  d.setAuthTag(fromB64url(tag));
  return Buffer.concat([d.update(fromB64url(ct)), d.final()]).toString('utf8');
}
