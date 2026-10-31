import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { hashToken, randomToken } from '../crypto.js';
import { PathError, extOf, normalizeSitePath } from '../deploy/paths.js';
import type { SiteRepo } from '../sites.js';
import { type Lang, page, pickLang } from '../ui/page.js';

/**
 * Preview links (docs/ARCHITECTURE.md, "Preview links"): a private, short-lived URL that shows a
 * draft as the site would look once published. Files the draft changed come from Postgres;
 * everything else is fetched from the live site. Served from /p/<token>/ on this host, so:
 * - every response carries `Content-Security-Policy: sandbox` (no allow-same-origin), which runs the
 *   draft's pages in an opaque origin: they can't read or set this host's cookies or storage;
 * - root-relative and same-site absolute URLs in HTML and CSS are rewritten under /p/<token>/;
 * - a banner says it's a draft, and nothing is indexed or cached.
 */

export const PREVIEW_TTL_S = 3600;
const LIVE_TIMEOUT_MS = 10_000;
const MAX_LIVE_BYTES = 30 * 1024 * 1024;

export type LiveFetch = (url: string, init: RequestInit) => Promise<globalThis.Response>;

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
};

const T = {
  es: { banner: 'Vista previa de un borrador', notLive: 'Aún no está publicado.', expiredTitle: 'Esta vista previa ya no está disponible', expiredBody: 'Venció o el borrador ya se publicó o descartó. Pídale a su asistente una vista previa nueva.', notFound: 'No encontrado' },
  en: { banner: 'Draft preview', notLive: 'Not published yet.', expiredTitle: 'This preview is no longer available', expiredBody: 'It expired, or the draft was already published or discarded. Ask your assistant for a new preview.', notFound: 'Not found' },
} as const;

const PATH_RE = /^\/([A-Za-z0-9_-]{20,64})(\/.*)?$/;
const ABS_URL_RE = /^(?:https?:)?\/\/([^/?#]+)(.*)$/i;

export interface PreviewTarget {
  draftId: string;
  siteId: string;
  domain: string;
}

export class PreviewService {
  constructor(
    private readonly pool: Pool,
    private readonly sites: SiteRepo,
    private readonly publicUrl: string,
    private readonly fetchLive: LiveFetch = fetch,
  ) {}

  /** A new link for the draft, valid for an hour (or until the draft is published, discarded or expires). */
  async createLink(draftId: string, siteId: string): Promise<{ url: string; expiresAt: Date }> {
    const token = randomToken(24);
    const r = await this.pool.query(
      `INSERT INTO preview_links (token_hash, draft_id, site_id, expires_at)
       SELECT $1, d.id, d.site_id, LEAST(d.expires_at, now() + make_interval(secs => $4)) FROM drafts d WHERE d.id = $2 AND d.site_id = $3
       RETURNING expires_at`,
      [hashToken(token), draftId, siteId, PREVIEW_TTL_S],
    );
    if (!r.rows[0]) throw new Error('draft not found');
    return { url: `${this.publicUrl}/p/${token}/`, expiresAt: r.rows[0].expires_at };
  }

  async resolve(token: string): Promise<PreviewTarget | undefined> {
    const r = (await this.pool.query(
      `SELECT l.draft_id, l.site_id FROM preview_links l JOIN drafts d ON d.id = l.draft_id
       WHERE l.token_hash = $1 AND l.expires_at > now() AND d.expires_at > now()`,
      [hashToken(token)],
    )).rows[0];
    if (!r) return undefined;
    const site = await this.sites.byId(r.site_id);
    return site && site.status === 'active' ? { draftId: r.draft_id, siteId: r.site_id, domain: site.domain } : undefined;
  }

  /** The draft's version of one path: content, deleted, or undefined when the draft didn't touch it. */
  private async draftFile(draftId: string, path: string): Promise<{ deleted: boolean; content: Buffer | null } | undefined> {
    const r = (await this.pool.query('SELECT deleted, content FROM draft_files WHERE draft_id = $1 AND path = $2', [draftId, path])).rows[0];
    return r ? { deleted: r.deleted, content: r.content } : undefined;
  }

  /** Express handler mounted at /p. req.path is "/<token>/<site path>". */
  async handle(req: Request, res: Response): Promise<void> {
    const lang = pickLang(req.get('accept-language'));
    securityHeaders(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.status(405).set('allow', 'GET, HEAD').end();

    const m = req.path.match(PATH_RE);
    const target = m ? await this.resolve(m[1]!) : undefined;
    if (!m || !target) return void res.status(404).type('html').send(page({ lang, title: T[lang].expiredTitle, state: 'info', body: `<p>${T[lang].expiredBody}</p>` }));
    const prefix = `/p/${m[1]}`;
    if (!m[2]) return void res.redirect(302, `${prefix}/`);

    let rawPath: string;
    try {
      rawPath = m[2].split('/').map((s) => decodeURIComponent(s)).join('/');
    } catch {
      return void res.status(400).end();
    }
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';

    // Directory URLs: the draft's index.html / index.htm if it has one, else whatever the live site serves.
    // A candidate the draft deletes falls through to the next one, as the server's directory index does.
    const candidates = rawPath.endsWith('/') ? [`${rawPath}index.html`, `${rawPath}index.htm`] : [rawPath];
    let deleted = false;
    for (const c of candidates) {
      let path: string;
      try {
        path = normalizeSitePath(c);
      } catch (e) {
        if (e instanceof PathError) continue;
        throw e;
      }
      const f = await this.draftFile(target.draftId, path);
      if (!f) continue;
      if (f.deleted || !f.content) {
        deleted = true;
        continue;
      }
      return void this.send(req, res, target, prefix, lang, MIME[extOf(path)] ?? 'application/octet-stream', f.content, 200);
    }
    if (deleted) return void this.notFound(res, lang);
    await this.proxyLive(req, res, target, prefix, lang, m[2] + query);
  }

  private async proxyLive(req: Request, res: Response, t: PreviewTarget, prefix: string, lang: Lang, pathAndQuery: string): Promise<void> {
    let live: globalThis.Response;
    try {
      live = await this.fetchLive(`https://${t.domain}${pathAndQuery}`, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': 'CR Servers preview', accept: req.get('accept') ?? '*/*' },
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      });
    } catch {
      return void res.status(502).type('text/plain').send('The live site did not respond.');
    }
    if (live.status >= 300 && live.status < 400) {
      const loc = live.headers.get('location') ?? '/';
      return void res.redirect(302, rewriteUrl(loc, t.domain, prefix) ?? loc);
    }
    if (live.status === 404) return void this.notFound(res, lang);
    if (Number(live.headers.get('content-length') ?? 0) > MAX_LIVE_BYTES) return void res.status(413).end();
    const body = Buffer.from(await live.arrayBuffer());
    if (body.length > MAX_LIVE_BYTES) return void res.status(413).end();
    this.send(req, res, t, prefix, lang, live.headers.get('content-type') ?? 'application/octet-stream', body, live.status);
  }

  private send(req: Request, res: Response, t: PreviewTarget, prefix: string, lang: Lang, type: string, body: Buffer, status: number): void {
    let out = body;
    if (type.startsWith('text/html')) out = Buffer.from(rewriteHtml(body.toString('utf8'), t.domain, prefix, lang), 'utf8');
    else if (type.startsWith('text/css')) out = Buffer.from(rewriteCss(body.toString('utf8'), t.domain, prefix), 'utf8');
    res.status(status).type(type).set('content-length', String(out.length));
    if (req.method === 'HEAD') return void res.end();
    res.end(out);
  }

  private notFound(res: Response, lang: Lang): void {
    res.status(404).type('html').send(page({ lang, title: T[lang].notFound, state: 'info', body: '' }));
  }
}

function securityHeaders(res: Response): void {
  res.set({
    'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
    'x-robots-tag': 'noindex, nofollow',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    // Sandboxed pages have an opaque origin, so fonts and module scripts load in CORS mode.
    'access-control-allow-origin': '*',
  });
}

/** Maps a URL found in a page to its preview URL, or null when it points elsewhere. */
export function rewriteUrl(url: string, domain: string, prefix: string): string | null {
  const u = url.trim();
  if (u.startsWith('/') && !u.startsWith('//')) return u.startsWith(`${prefix}/`) ? u : `${prefix}${u}`;
  const m = u.match(ABS_URL_RE);
  if (m && [domain, `www.${domain}`].includes(m[1]!.toLowerCase())) return `${prefix}${m[2]!.startsWith('/') ? m[2] : `/${m[2]}`}`;
  return null;
}

const ATTR_RE = /(\s(?:href|src|action|poster|data|formaction|background)\s*=\s*)(["'])(.*?)\2/gi;
const SRCSET_RE = /(\ssrcset\s*=\s*)(["'])(.*?)\2/gi;

export function rewriteHtml(html: string, domain: string, prefix: string, lang: Lang): string {
  let out = html.replace(ATTR_RE, (all, pre: string, q: string, url: string) => {
    const r = rewriteUrl(url, domain, prefix);
    return r ? `${pre}${q}${r}${q}` : all;
  });
  out = out.replace(SRCSET_RE, (_all, pre: string, q: string, set: string) => {
    const parts = set.split(',').map((c) => {
      const [u, ...rest] = c.trim().split(/\s+/);
      const r = u ? rewriteUrl(u, domain, prefix) : null;
      return [r ?? u, ...rest].join(' ');
    });
    return `${pre}${q}${parts.join(', ')}${q}`;
  });
  out = rewriteCss(out, domain, prefix); // inline styles and <style> blocks

  const banner =
    `<div style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;gap:8px;justify-content:center;align-items:center;flex-wrap:wrap;` +
    `padding:8px 12px;background:linear-gradient(90deg,#009DD4,#005C9F);color:#fff;font:600 14px/1.4 Roboto,Helvetica,Arial,sans-serif;` +
    `box-shadow:0 -2px 8px rgba(0,0,0,.2)" role="status">${T[lang].banner}: ${escapeHtml(domain)}. <span style="font-weight:400">${T[lang].notLive}</span></div>`;
  const robots = '<meta name="robots" content="noindex, nofollow">';
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (h) => h + robots) : robots + out;
  const lastBody = out.toLowerCase().lastIndexOf('</body>');
  return lastBody >= 0 ? out.slice(0, lastBody) + banner + out.slice(lastBody) : out + banner;
}

const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(["'])([^"']+)\1/gi;

export function rewriteCss(css: string, domain: string, prefix: string): string {
  return css
    .replace(CSS_URL_RE, (all, q: string, url: string) => {
      const r = rewriteUrl(url, domain, prefix);
      return r ? `url(${q}${r}${q})` : all;
    })
    .replace(CSS_IMPORT_RE, (all, q: string, url: string) => {
      const r = rewriteUrl(url, domain, prefix);
      return r ? `@import ${q}${r}${q}` : all;
    });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
