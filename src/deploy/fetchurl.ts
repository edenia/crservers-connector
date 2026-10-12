import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { extOf } from './paths.js';

/**
 * Downloads a media file from a public URL for import_from_url (docs/ARCHITECTURE.md, "Importing
 * files"). Only public addresses: every connection (including after redirects) is checked at
 * connect time, so DNS tricks can't reach the cluster or internal networks.
 */

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
// No ::ffff:0:0/96 here: BlockList would match plain IPv4 against it. Mapped addresses are unwrapped below.
for (const [net, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return false;
  if (v === 6 && ip.toLowerCase().startsWith('::ffff:')) return isPublicAddress(ip.slice(7));
  return !blocked.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

/** DNS lookup that refuses non-public answers; used as the socket's lookup, so it applies to every connection. */
function publicLookup(hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) return cb(Object.assign(new Error('Address not allowed'), { code: 'EBLOCKED' }), '');
    if ((options as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

/** Share links → direct downloads (Google Drive, Dropbox). Other URLs unchanged. */
export function directDownloadUrl(raw: string): string {
  const u = new URL(raw);
  const drive = u.hostname === 'drive.google.com' && u.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)/);
  if (drive) return `https://drive.google.com/uc?export=download&id=${drive[1]}`;
  if ((u.hostname === 'www.dropbox.com' || u.hostname === 'dropbox.com') && u.searchParams.get('dl') !== '1') {
    u.searchParams.set('dl', '1');
    return u.href;
  }
  return u.href;
}

export interface Downloaded {
  data: Buffer;
  contentType: string;
  finalUrl: string;
}

export type UrlFetcher = (url: string, maxBytes: number) => Promise<Downloaded>;

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;

export const fetchPublicUrl: UrlFetcher = async (rawUrl, maxBytes) => {
  let url = new URL(directDownloadUrl(rawUrl));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ImportError('Only http(s) links are supported');
    if (url.username || url.password) throw new ImportError('Links with credentials are not supported');
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new ImportError('Address not allowed');
    const res = await get(url, maxBytes);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, url);
      continue;
    }
    if (res.status !== 200) throw new ImportError(`The link answered HTTP ${res.status}`);
    return { data: res.body!, contentType: res.contentType, finalUrl: url.href };
  }
  throw new ImportError('Too many redirects');
};

function get(url: URL, maxBytes: number): Promise<{ status: number; location?: string; contentType: string; body?: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { lookup: publicLookup as never, timeout: TIMEOUT_MS, headers: { 'user-agent': 'CR Servers connector (import)', accept: '*/*' } }, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers['content-type'] ?? '');
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ status, location: res.headers.location, contentType });
      }
      if (status !== 200) {
        res.resume();
        return resolve({ status, contentType });
      }
      if (Number(res.headers['content-length'] ?? 0) > maxBytes) {
        res.destroy();
        return reject(new ImportError(`File too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          reject(new ImportError(`File too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`));
        } else chunks.push(c);
      });
      res.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new ImportError('The link took too long to answer')));
    req.on('error', (e: NodeJS.ErrnoException) => reject(e instanceof ImportError ? e : new ImportError(e.code === 'EBLOCKED' ? 'Address not allowed' : `Could not download (${e.code ?? e.message})`)));
  });
}

/** Media types import_from_url accepts, with the first bytes each must start with. Text files the AI writes itself. */
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  avif: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(b.subarray(8, 12).toString('latin1')),
  ico: (b) => b.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])),
  svg: (b) => /<svg[\s>]/i.test(b.subarray(0, 4096).toString('utf8')),
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  mp4: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  webm: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  mp3: (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  woff: (b) => b.subarray(0, 4).toString('latin1') === 'wOFF',
  woff2: (b) => b.subarray(0, 4).toString('latin1') === 'wOF2',
  ttf: (b) => b.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || b.subarray(0, 4).toString('latin1') === 'true',
  otf: (b) => b.subarray(0, 4).toString('latin1') === 'OTTO',
};
SIGNATURES.jpeg = SIGNATURES.jpg!;

export const IMPORTABLE_EXT = Object.keys(SIGNATURES).sort();

/** Throws ImportError unless `path` is an importable media type and `data` really is that type. */
export function assertMediaMatches(path: string, data: Buffer): void {
  const ext = extOf(path);
  const check = SIGNATURES[ext];
  if (!check) throw new ImportError(`import_from_url only brings in media files (${IMPORTABLE_EXT.join(', ')}); write text files with write_files`);
  if (!check(data)) throw new ImportError(`The downloaded file is not a .${ext} file (did the link return a web page instead of the file?)`);
}
