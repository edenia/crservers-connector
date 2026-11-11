import { randomBytes } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { hashToken, randomToken } from '../crypto.js';
import type { DeployCore } from '../deploy/core.js';
import { ImportError, assertMediaMatches } from '../deploy/fetchurl.js';
import { MB, PathError, extOf, maxFileBytes, normalizeSiteDir, normalizeSitePath } from '../deploy/paths.js';
import type { SiteFs } from '../deploy/sitefs.js';
import type { SiteRepo } from '../sites.js';
import { type Lang, esc, page, pickLang } from '../ui/page.js';

/**
 * Upload links (docs/ARCHITECTURE.md, "Upload links"): a private, short-lived URL that takes media
 * files into one draft, for AI apps that can't hand a chat attachment to the connector (Claude).
 * Two ways to use the same link:
 * - the assistant sends the file itself from its code sandbox: `PUT /upload/<token>/<file name>`;
 * - the site owner opens `/upload/<token>` on their phone or computer and picks the files.
 * The token is the only credential, so the link can do very little: add media files to one folder
 * of one draft. Nothing goes live without preview and publish; it lists nothing but its own uploads.
 */

export const UPLOAD_TTL_S = 3600;
/** Files one link accepts (a draft holds at most 2,000 files anyway). */
export const UPLOAD_MAX_FILES = 60;
/** Widths of extra copies the upload page can make for srcset (name-800.jpg, …). */
export const WIDTH_MIN = 200;
export const WIDTH_MAX = 2000;
/** Longest side of a photo resized by the upload page, and its JPEG quality. */
const PHOTO_MAX_PX = 2000;
const PHOTO_QUALITY = 0.78;

const PATH_RE = /^\/([A-Za-z0-9_-]{20,64})(?:\/([^/]*))?\/?$/;

export interface UploadedFile {
  path: string;
  size: number;
}

export interface UploadTarget {
  tokenHash: string;
  draftId: string;
  siteId: string;
  domain: string;
  folder: string;
  widths: number[];
  protectedDirs: string[];
  files: number;
  expiresAt: Date;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * "IMG 0001 (1).JPG" → "img-0001-1.jpg", "Árbol de Navidad.png" → "arbol-de-navidad.png".
 * Web-safe names only: lowercase ASCII letters, digits, "-", "_" and one extension.
 */
export function safeFileName(raw: string): string {
  const base = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  const clean = (s: string) =>
    s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  const ext = dot > 0 ? clean(base.slice(dot + 1)) : '';
  const stem = clean(dot > 0 ? base.slice(0, dot) : base).slice(0, 80).replace(/[-_]+$/, '');
  if (!ext) throw new UploadError(400, 'The file name needs an extension that says its type, e.g. "foto.jpg"');
  return `${stem || 'archivo'}.${ext === 'jpeg' ? 'jpg' : ext}`;
}

/** "img/foto.jpg" → "img/foto-2.jpg" → "img/foto-3.jpg" … until `taken` says it's free. */
export async function freePath(path: string, taken: (p: string) => Promise<boolean>): Promise<string> {
  if (!(await taken(path))) return path;
  const dot = path.lastIndexOf('.');
  for (let n = 2; n < 1000; n++) {
    const candidate = `${path.slice(0, dot)}-${n}${path.slice(dot)}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new UploadError(409, 'Too many files with this name');
}

export interface UploadDeps {
  pool: Pool;
  sites: SiteRepo;
  core: DeployCore;
  openFs: (siteId: string) => Promise<SiteFs>;
  publicUrl: string;
}

export class UploadService {
  /** One upload at a time per draft: a draft is read, changed and saved as a whole. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly body = express.raw({ type: () => true, limit: 100 * MB + 1024 });

  constructor(private readonly d: UploadDeps) {}

  /** A new link for the draft, valid for an hour (or until the draft is published, discarded or expires). */
  async createLink(draftId: string, siteId: string, folder: string, widths: number[] = []): Promise<{ url: string; expiresAt: Date }> {
    const token = randomToken(24);
    const r = await this.d.pool.query(
      `INSERT INTO upload_links (token_hash, draft_id, site_id, folder, widths, expires_at)
       SELECT $1, d.id, d.site_id, $4, $5, LEAST(d.expires_at, now() + make_interval(secs => $6)) FROM drafts d WHERE d.id = $2 AND d.site_id = $3
       RETURNING expires_at`,
      [hashToken(token), draftId, siteId, normalizeSiteDir(folder), JSON.stringify(widths), UPLOAD_TTL_S],
    );
    if (!r.rows[0]) throw new Error('draft not found');
    return { url: `${this.d.publicUrl}/upload/${token}`, expiresAt: r.rows[0].expires_at };
  }

  /** Files that arrived through this draft's upload links and are still in the draft, oldest first. */
  async uploaded(draftId: string): Promise<UploadedFile[]> {
    const r = await this.d.pool.query(
      `SELECT u.path, octet_length(f.content) AS size FROM upload_files u
       JOIN draft_files f ON f.draft_id = u.draft_id AND f.path = u.path AND NOT f.deleted
       WHERE u.draft_id = $1 ORDER BY u.at, u.path`,
      [draftId],
    );
    return r.rows.map((x) => ({ path: x.path as string, size: Number(x.size) }));
  }

  async resolve(token: string): Promise<UploadTarget | undefined> {
    const tokenHash = hashToken(token);
    const r = (await this.d.pool.query(
      `SELECT l.draft_id, l.site_id, l.folder, l.widths, l.files, l.expires_at FROM upload_links l JOIN drafts d ON d.id = l.draft_id
       WHERE l.token_hash = $1 AND l.expires_at > now() AND d.expires_at > now()`,
      [tokenHash],
    )).rows[0];
    if (!r) return undefined;
    const site = await this.d.sites.byId(r.site_id);
    if (!site || site.status !== 'active') return undefined;
    return {
      tokenHash, draftId: r.draft_id, siteId: r.site_id, domain: site.domain, folder: r.folder, widths: r.widths as number[],
      protectedDirs: site.protectedDirs, files: r.files, expiresAt: r.expires_at,
    };
  }

  /**
   * Adds one file to the link's draft. `unique` keeps an existing file of the same name (the new one
   * gets "-2"); without it the name is the sender's choice and replaces that file in the draft.
   */
  async store(t: UploadTarget, rawName: string, data: Buffer, unique: boolean): Promise<UploadedFile> {
    if (!data.length) throw new UploadError(400, 'The file is empty');
    const name = safeFileName(rawName);
    let path: string;
    try {
      path = normalizeSitePath(t.folder ? `${t.folder}/${name}` : name);
    } catch (e) {
      throw new UploadError(400, (e as Error).message);
    }
    if (t.protectedDirs.some((dir) => path === dir || path.startsWith(`${dir}/`))) throw new UploadError(403, 'That folder belongs to another site in this hosting account');
    if (data.length > maxFileBytes(path)) throw new UploadError(413, `File too large (max ${maxFileBytes(path) / MB} MB)`);
    try {
      assertMediaMatches(path, data);
    } catch (e) {
      if (!(e instanceof ImportError)) throw e;
      throw new UploadError(415, extOf(path) && e.message.includes('is not a') ? `The file is not really a .${extOf(path)} file` : 'Only media files are accepted here: images, video, audio, fonts and PDF');
    }
    return this.inTurn(t.draftId, async () => {
      // Counted first, so parallel requests can't go past the cap.
      const slot = await this.d.pool.query('UPDATE upload_links SET files = files + 1 WHERE token_hash = $1 AND files < $2 AND expires_at > now()', [t.tokenHash, UPLOAD_MAX_FILES]);
      if (!slot.rowCount) throw new UploadError(429, 'This link has taken all the files it can; ask your assistant for a new one');
      const fs = await this.d.openFs(t.siteId);
      try {
        if (unique) {
          const draft = await this.d.core.getDraft(t.draftId, t.siteId);
          path = await freePath(path, async (p) => draft.writes.has(p) || (!draft.deletes.has(p) && (await fs.stat(p)) !== null));
        }
        const [res] = await this.d.core.writeFiles(t.draftId, t.siteId, fs, [{ path, content: data }]);
        if (!res?.ok) throw new UploadError(400, res?.error ?? 'Could not add the file');
        await this.d.pool.query(
          `INSERT INTO upload_files (draft_id, path) VALUES ($1, $2) ON CONFLICT (draft_id, path) DO UPDATE SET at = now()`,
          [t.draftId, path],
        );
        return { path, size: data.length };
      } catch (e) {
        await this.d.pool.query('UPDATE upload_links SET files = files - 1 WHERE token_hash = $1', [t.tokenHash]).catch(() => undefined);
        throw e;
      } finally {
        await fs.close().catch(() => undefined);
      }
    });
  }

  private inTurn<T>(draftId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(draftId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.queues.set(draftId, tail);
    void tail.then(() => {
      if (this.queues.get(draftId) === tail) this.queues.delete(draftId);
    });
    return run;
  }

  /** Express handler mounted at /upload. req.path is "/<token>" (the page) or "/<token>/<file name>" (one file). */
  async handle(req: Request, res: Response): Promise<void> {
    const lang = pickLang(req.get('accept-language'));
    const nonce = randomBytes(16).toString('base64');
    res.set({
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' blob:; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'x-robots-tag': 'noindex, nofollow',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    const m = req.path.match(PATH_RE);
    const sending = req.method === 'PUT' || req.method === 'POST';
    const target = m ? await this.resolve(m[1]!) : undefined;
    if (!m || !target) {
      if (sending) return void res.status(404).json({ ok: false, error: 'This upload link is no longer valid (it lasts 1 hour and ends when the draft is published or discarded). Ask for a new one with get_upload_link.' });
      return void res.status(404).type('html').send(page({ lang, title: T[lang].expiredTitle, state: 'info', body: `<p>${T[lang].expiredBody}</p>` }));
    }

    if (sending) {
      try {
        if (!m[2]) throw new UploadError(400, 'Put the file name at the end of the address: PUT <upload_url>/foto.jpg, with the file as the request body');
        if ((req.get('content-type') ?? '').toLowerCase().startsWith('multipart/')) throw new UploadError(415, 'Send the file itself as the request body (curl -T foto.jpg "<upload_url>/foto.jpg"), not a multipart form');
        if (Number(req.get('content-length') ?? 0) > 100 * MB) throw new UploadError(413, 'File too large');
        await new Promise<void>((resolve, reject) => this.body(req, res, (e?: unknown) => (e ? reject(e) : resolve())));
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const file = await this.store(target, decodeURIComponent(m[2]), data, req.query.unique === '1');
        return void res.status(201).json({ ok: true, ...file });
      } catch (e) {
        if (e instanceof UploadError) return void res.status(e.status).json({ ok: false, error: e.message });
        if (e instanceof PathError || e instanceof URIError) return void res.status(400).json({ ok: false, error: e.message });
        if ((e as { type?: string }).type === 'entity.too.large') return void res.status(413).json({ ok: false, error: 'File too large' });
        const code = (e as { code?: string }).code;
        if (code === 'not_found' || code === 'expired') return void res.status(404).json({ ok: false, error: 'The draft is gone; start a new one' });
        if (code === 'limit') return void res.status(413).json({ ok: false, error: (e as Error).message });
        throw e;
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.status(405).set('allow', 'GET, HEAD, PUT, POST').end();
    if (m[2]) return void res.status(404).json({ ok: false, error: 'Nothing to download here: this link only takes files (PUT)' });
    const uploaded = (await this.uploaded(target.draftId)).filter((f) => !target.folder || f.path.startsWith(`${target.folder}/`));
    res.type('html').send(uploadPage(lang, target, uploaded, nonce));
  }
}

const T = {
  es: {
    title: 'Suba sus fotos',
    intro: (domain: string, folder: string) => `Las fotos que elija se agregan al borrador de <strong>${esc(domain)}</strong>${folder ? `, en la carpeta <code>${esc(folder)}/</code>` : ''}. Nada se publica todavía: su asistente le mostrará una vista previa antes.`,
    pick: 'Elegir fotos',
    drop: 'o arrástrelas aquí',
    note: 'Las fotos grandes se reducen en su dispositivo antes de enviarse (máximo 2000 px) y se les quita la ubicación.',
    done: 'Listo. Vuelva al chat y dígale a su asistente que ya subió las fotos.',
    sending: 'Enviando…',
    failed: 'No se pudo subir',
    why: {
      404: 'el enlace venció; pídale uno nuevo a su asistente',
      413: 'el archivo es demasiado grande (máximo 25 MB; video, 100 MB)',
      415: 'este tipo de archivo no se acepta (solo imágenes, video, audio, fuentes y PDF)',
      429: 'este enlace ya recibió todos los archivos que admite; pídale uno nuevo a su asistente',
      0: 'intente de nuevo',
    },
    already: 'Ya en el borrador',
    expires: 'Este enlace funciona durante una hora.',
    expiredTitle: 'Este enlace ya no está disponible',
    expiredBody: 'Venció, o el borrador ya se publicó o se descartó. Pídale a su asistente un enlace nuevo para subir fotos.',
  },
  en: {
    title: 'Upload your photos',
    intro: (domain: string, folder: string) => `The photos you choose are added to the draft of <strong>${esc(domain)}</strong>${folder ? `, in the <code>${esc(folder)}/</code> folder` : ''}. Nothing is published yet: your assistant will show you a preview first.`,
    pick: 'Choose photos',
    drop: 'or drop them here',
    note: 'Large photos are made smaller on your device before they are sent (2000 px at most), and their location data is removed.',
    done: 'Done. Go back to the chat and tell your assistant the photos are uploaded.',
    sending: 'Sending…',
    failed: 'Could not upload',
    why: {
      404: 'the link expired; ask your assistant for a new one',
      413: 'the file is too large (25 MB at most; video, 100 MB)',
      415: 'this kind of file is not accepted (only images, video, audio, fonts and PDF)',
      429: 'this link has taken all the files it can; ask your assistant for a new one',
      0: 'please try again',
    },
    already: 'Already in the draft',
    expires: 'This link works for one hour.',
    expiredTitle: 'This link is no longer available',
    expiredBody: 'It expired, or the draft was already published or discarded. Ask your assistant for a new upload link.',
  },
} as const;

const PAGE_CSS = `.drop{border:2px dashed #b9c4d4;border-radius:16px;padding:24px 16px;text-align:center;margin:16px 0}.drop.over{border-color:#006EBF;background:#e6f4ff}
.drop .btn{cursor:pointer}.drop input{position:absolute;width:1px;height:1px;opacity:0}.drop input:focus-visible+span{outline:2px solid #006EBF;outline-offset:2px}
ul.up{list-style:none;margin:12px 0 0;padding:0}ul.up li{display:flex;gap:8px;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f2f5;font-size:.875rem;overflow-wrap:anywhere}
ul.up .ok{color:#067647;font-weight:700}ul.up .bad{color:#b42318}`;

/** Exported for tests. */
export function uploadPage(lang: Lang, t: Pick<UploadTarget, 'domain' | 'folder' | 'widths'>, uploaded: UploadedFile[], nonce: string): string {
  const s = T[lang];
  const cfg = { widths: t.widths, max: PHOTO_MAX_PX, quality: PHOTO_QUALITY, t: { sending: s.sending, failed: s.failed, why: s.why } };
  const body = `<style>${PAGE_CSS}</style>
<p>${s.intro(t.domain, t.folder)}</p>
<div class="drop" id="drop"><label><input type="file" id="pick" multiple accept="image/*,video/mp4,video/webm,audio/mpeg,application/pdf"><span class="btn">${s.pick}</span></label><p class="muted small">${s.drop}</p></div>
<p class="notice small" id="done" hidden role="status">${s.done}</p>
<ul class="up" id="list" aria-live="polite">${uploaded.map((f) => `<li><span>${esc(f.path)}</span><span class="muted">${s.already}</span></li>`).join('')}</ul>
<p class="muted small">${s.note} ${s.expires}</p>
<script nonce="${nonce}">const CFG=${JSON.stringify(cfg).replace(/</g, '\\u003c')};${PAGE_JS}</script>`;
  return page({ lang, title: s.title, body });
}

/**
 * The page's script. Photos (JPEG, WebP, and HEIC where the browser can decode it) are redrawn on a
 * canvas: at most CFG.max px on the long side, JPEG, which also drops EXIF (location). Other files
 * go up as they are. One request per file, in order.
 */
const PAGE_JS = `
const list=document.getElementById('list'),drop=document.getElementById('drop'),pick=document.getElementById('pick'),done=document.getElementById('done');
const base=location.pathname.replace(/\\/+$/,'');
function row(name){const li=document.createElement('li'),a=document.createElement('span'),b=document.createElement('span');a.textContent=name;b.textContent=CFG.t.sending;b.className='muted';li.append(a,b);list.append(li);return{a,b}}
async function draw(bmp,k){const c=document.createElement('canvas');c.width=Math.max(1,Math.round(bmp.width*k));c.height=Math.max(1,Math.round(bmp.height*k));
const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.drawImage(bmp,0,0,c.width,c.height);return new Promise(r=>c.toBlob(r,'image/jpeg',CFG.quality))}
async function versions(file){const stem=file.name.replace(/\\.[^.]*$/,'')||'foto';
if(!/^image\\/(jpeg|webp|heic|heif)$/.test(file.type)&&!/\\.(jpe?g|webp|heic|heif)$/i.test(file.name))return[{name:file.name,blob:file}];
let bmp;try{bmp=await createImageBitmap(file,{imageOrientation:'from-image'})}catch(e){return[{name:file.name,blob:file}]}
const k=Math.min(1,CFG.max/Math.max(bmp.width,bmp.height)),main=await draw(bmp,k);if(!main)return[{name:file.name,blob:file}];
const out=[{name:stem+'.jpg',blob:main}];
// Extra copies by image width, only narrower than the main one.
for(const w of CFG.widths){if(w>=Math.round(bmp.width*k))continue;const b=await draw(bmp,w/bmp.width);if(b)out.push({name:stem+'-'+w+'.jpg',blob:b,of:stem})}
bmp.close&&bmp.close();return out}
async function send(v,to){const r=row(v.name);try{const res=await fetch(base+'/'+encodeURIComponent(to||v.name)+(to?'':'?unique=1'),{method:'PUT',body:v.blob,headers:{'content-type':'application/octet-stream'}});
const j=await res.json().catch(()=>({}));if(!res.ok||!j.ok)throw new Error(CFG.t.why[res.status]||CFG.t.why[0]);r.a.textContent=j.path;r.b.textContent='✓ '+Math.max(1,Math.round(j.size/1024))+' KB';r.b.className='ok';return j.path}
catch(e){r.b.textContent=CFG.t.failed+': '+(e instanceof TypeError?CFG.t.why[0]:e.message);r.b.className='bad';return null}}
let busy=Promise.resolve();
function take(files){busy=busy.then(async()=>{let any=false;for(const f of files){const vs=await versions(f);const first=await send(vs[0]);if(!first)continue;any=true;
// Extra widths follow the name the first copy got ("foto-2.jpg" → "foto-2-800.jpg").
const got=first.slice(first.lastIndexOf('/')+1).replace(/\\.[^.]*$/,'');for(const v of vs.slice(1))await send(v,got+v.name.slice(v.of.length))}
if(any)done.hidden=false})}
pick.addEventListener('change',()=>{take([...pick.files]);pick.value=''});
for(const ev of['dragenter','dragover'])drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over')});
for(const ev of['dragleave','drop'])drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over')});
drop.addEventListener('drop',e=>{take([...e.dataTransfer.files])});
`;
