import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { ClientAreaApi } from '../auth/clientarea.js';
import { signReq } from '../auth/req.js';
import { hashToken, randomToken, safeEqual } from '../crypto.js';
import { DeployError, type DeployCore } from '../deploy/core.js';
import type { AuditLog } from '../deploy/pgstores.js';
import type { SiteFs } from '../deploy/sitefs.js';
import type { PreviewService } from '../preview/preview.js';
import type { Site, SiteRepo } from '../sites.js';
import { esc, type Lang, page, pickLang } from '../ui/page.js';

/**
 * Approval link (docs/ARCHITECTURE.md, "Approval link"). When the client turned on "Aprobar cada
 * publicación" (off by default), changes don't go live from the chat: `publish` returns
 * /approve/<id> instead. Opening it sends the browser through the client area with a signed
 * "approve" request; the plugin checks that the signed-in client owns the site and returns a
 * one-time code. The page then shows the change and a preview, and publishes only if the
 * draft is still exactly the version the AI asked about.
 */

const SIGNIN_TTL_S = 600;
const SESSION_TTL_S = 1800;
const APPROVAL_TTL_S = 24 * 3600;
const BIND_COOKIE = 'crs_abind';
const SESSION_COOKIE = 'crs_appr';

export type ApprovalReason = 'always';

/**
 * Why a change needs the owner's approval in the browser; empty = the chat confirmation is enough.
 * Opt-in only: size-based rules (20+ files, deletions, the home page) were tried on staging and
 * dropped. The preview link plus one-step undo cover ordinary changes better than a second sign-in.
 */
export function approvalReasons(_s: { added: string[]; modified: string[]; deleted: string[] }, site: Pick<Site, 'approveEveryPublish'>): ApprovalReason[] {
  return site.approveEveryPublish ? ['always'] : [];
}

interface ApprovalRow {
  id: string;
  site_id: string;
  draft_id: string;
  draft_version: number;
  client_id: string;
  reasons: ApprovalReason[];
  summary: { added: string[]; modified: string[]; deleted: string[] };
  status: 'pending' | 'approved' | 'rejected';
  release_number: number | null;
  session_hash: string | null;
  session_expires_at: Date | null;
  expires_at: Date;
}

export type ApprovalState =
  | { status: 'pending'; url: string; expiresAt: Date }
  | { status: 'approved'; release: number }
  | { status: 'rejected' };

export interface ApprovalDeps {
  pool: Pool;
  sites: SiteRepo;
  core: DeployCore;
  audit: AuditLog;
  openFs: (siteId: string) => Promise<SiteFs>;
  preview: Pick<PreviewService, 'createLink'>;
  clientArea: ClientAreaApi;
  clientAreaUrl: string;
  reqKey: Buffer;
  publicUrl: string;
  appName?: (clientId: string) => Promise<string>;
}

const T = {
  es: {
    title: 'Aprobar publicación',
    lead: (app: string, domain: string) => `${app} quiere publicar estos cambios en <strong>${domain}</strong>.`,
    why: 'Le pedimos confirmar porque:',
    reasons: { always: 'Usted pidió aprobar cada publicación.' } as Record<ApprovalReason, string>,
    added: 'Nuevos',
    modified: 'Modificados',
    deleted: 'Borrados',
    more: (n: number) => `y ${n} más`,
    preview: 'Ver vista previa',
    approve: 'Publicar',
    reject: 'No publicar',
    undo: 'Después podrá deshacerlo pidiéndoselo a su asistente.',
    doneTitle: 'Publicado',
    doneBody: (n: number, url: string) => `Los cambios ya están en línea como versión #${n}. <a href="${url}">Ver el sitio</a>. Puede volver a su asistente.`,
    rejectedTitle: 'No se publicó',
    rejectedBody: 'Los cambios quedaron sin publicar. Puede volver a su asistente.',
    expiredTitle: 'Esta solicitud ya no está disponible',
    expiredBody: 'Venció o el borrador cambió. Pídale a su asistente que lo publique de nuevo.',
    changedBody: 'El borrador cambió después de pedir la aprobación, así que no publicamos nada. Pídale a su asistente que lo publique de nuevo.',
    conflictBody: 'Algunos archivos cambiaron en el sitio mientras tanto, así que no publicamos nada. Pídale a su asistente que rehaga el cambio.',
    failedTitle: 'No se pudo publicar',
    failedBody: 'No se cambió nada en su sitio. Intente de nuevo en unos minutos.',
    notOwnerTitle: 'No se pudo verificar',
    notOwnerBody: 'La cuenta con la que inició sesión no administra este sitio.',
  },
  en: {
    title: 'Approve publishing',
    lead: (app: string, domain: string) => `${app} wants to publish these changes to <strong>${domain}</strong>.`,
    why: 'We ask you to confirm because:',
    reasons: { always: 'You asked to approve every publish.' } as Record<ApprovalReason, string>,
    added: 'New',
    modified: 'Changed',
    deleted: 'Deleted',
    more: (n: number) => `and ${n} more`,
    preview: 'See the preview',
    approve: 'Publish',
    reject: "Don't publish",
    undo: 'You can undo it later by asking your assistant.',
    doneTitle: 'Published',
    doneBody: (n: number, url: string) => `The changes are live as release #${n}. <a href="${url}">See the site</a>. You can go back to your assistant.`,
    rejectedTitle: 'Not published',
    rejectedBody: 'The changes were not published. You can go back to your assistant.',
    expiredTitle: 'This request is no longer available',
    expiredBody: 'It expired or the draft changed. Ask your assistant to publish it again.',
    changedBody: 'The draft changed after approval was requested, so nothing was published. Ask your assistant to publish it again.',
    conflictBody: 'Some files changed on the site in the meantime, so nothing was published. Ask your assistant to redo the change.',
    failedTitle: "Couldn't publish",
    failedBody: 'Nothing changed on your site. Please try again in a few minutes.',
    notOwnerTitle: "Couldn't verify",
    notOwnerBody: "The account you signed in with doesn't manage this site.",
  },
} as const;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ApprovalService {
  constructor(private readonly d: ApprovalDeps) {}

  private url(id: string): string {
    return `${this.d.publicUrl}/approve/${id}`;
  }

  /** The most recent approval for a draft, whatever its version. */
  /** The site of a draft that went through approval (the draft itself is gone once published). */
  async siteOfDraft(draftId: string): Promise<string | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(draftId)) return undefined;
    return (await this.d.pool.query('SELECT site_id FROM approvals WHERE draft_id = $1 LIMIT 1', [draftId])).rows[0]?.site_id;
  }

  async latest(draftId: string, siteId: string): Promise<ApprovalRow | undefined> {
    return (await this.d.pool.query('SELECT * FROM approvals WHERE draft_id = $1 AND site_id = $2 ORDER BY created_at DESC LIMIT 1', [draftId, siteId])).rows[0];
  }

  /** Called by `publish` when approvalReasons() is not empty. Reuses a pending request for the same draft version. */
  async request(input: { draftId: string; siteId: string; version: number; clientId: string; reasons: ApprovalReason[]; summary: ApprovalRow['summary']; draftExpiresAt: Date }): Promise<ApprovalState> {
    const prev = (await this.d.pool.query<ApprovalRow>(
      'SELECT * FROM approvals WHERE draft_id = $1 AND draft_version = $2 AND site_id = $3 ORDER BY created_at DESC LIMIT 1',
      [input.draftId, input.version, input.siteId],
    )).rows[0];
    if (prev?.status === 'approved') return { status: 'approved', release: prev.release_number! };
    if (prev?.status === 'rejected') return { status: 'rejected' };
    if (prev && prev.expires_at > new Date()) return { status: 'pending', url: this.url(prev.id), expiresAt: prev.expires_at };

    const id = randomUUID();
    const expiresAt = new Date(Math.min(input.draftExpiresAt.getTime(), Date.now() + APPROVAL_TTL_S * 1000));
    await this.d.pool.query(
      `INSERT INTO approvals (id, site_id, draft_id, draft_version, client_id, reasons, summary, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, input.siteId, input.draftId, input.version, input.clientId, input.reasons, JSON.stringify(input.summary), expiresAt],
    );
    await this.d.audit.add(input.siteId, input.clientId, 'approval_requested', { approval_id: id, reasons: input.reasons });
    return { status: 'pending', url: this.url(id), expiresAt };
  }

  async ownsRid(rid: unknown): Promise<boolean> {
    if (typeof rid !== 'string' || !rid) return false;
    return (await this.d.pool.query('SELECT 1 FROM approval_signins WHERE rid = $1', [rid])).rowCount === 1;
  }

  private async load(id: string): Promise<{ a: ApprovalRow; site: Site } | undefined> {
    if (!ID_RE.test(id)) return undefined;
    const a = (await this.d.pool.query<ApprovalRow>('SELECT * FROM approvals WHERE id = $1', [id])).rows[0];
    const site = a && (await this.d.sites.byId(a.site_id));
    return a && site ? { a, site } : undefined;
  }

  private hasSession(req: Request, a: ApprovalRow): boolean {
    const s = readCookie(req.headers.cookie, SESSION_COOKIE);
    return Boolean(s && a.session_hash && a.session_expires_at && a.session_expires_at > new Date() && safeEqual(Buffer.from(hashToken(s)), Buffer.from(a.session_hash)));
  }

  /** GET /approve/:id */
  async show(req: Request, res: Response): Promise<void> {
    const lang = pickLang(req.get('accept-language'));
    noStore(res);
    const found = await this.load(String(req.params.id));
    if (!found) return this.message(res, lang, 404, T[lang].expiredTitle, T[lang].expiredBody);
    const { a, site } = found;
    if (a.status === 'approved') return this.message(res, lang, 200, T[lang].doneTitle, T[lang].doneBody(a.release_number!, `https://${esc(site.domain)}/`), 'ok');
    if (a.status === 'rejected') return this.message(res, lang, 200, T[lang].rejectedTitle, T[lang].rejectedBody);
    if (a.expires_at <= new Date()) return this.message(res, lang, 410, T[lang].expiredTitle, T[lang].expiredBody);
    if (!this.hasSession(req, a)) return this.startSignIn(res, a, site);

    let draftOk = true;
    try {
      const s = await this.d.core.summary(a.draft_id, a.site_id);
      draftOk = s.version === a.draft_version && s.previewed;
    } catch (e) {
      if (!(e instanceof DeployError)) throw e;
      draftOk = false;
    }
    if (!draftOk) return this.message(res, lang, 409, T[lang].expiredTitle, T[lang].changedBody);

    const preview = await this.d.preview.createLink(a.draft_id, a.site_id).catch(() => undefined);
    const app = esc(this.d.appName ? await this.d.appName(a.client_id) : a.client_id);
    const t = T[lang];
    const list = (label: string, paths: string[]) => {
      if (!paths.length) return '';
      const shown = paths.slice(0, 30).map((p) => `<li><code>${esc(p)}</code></li>`).join('');
      return `<h2>${label} (${paths.length})</h2><ul class="files">${shown}${paths.length > 30 ? `<li class="muted">${t.more(paths.length - 30)}</li>` : ''}</ul>`;
    };
    const body =
      `<p>${t.lead(app, esc(site.domain))}</p>` +
      `<p class="muted small">${t.why}</p><ul class="small">${a.reasons.map((r) => `<li>${t.reasons[r]}</li>`).join('')}</ul>` +
      list(t.modified, a.summary.modified) +
      list(t.added, a.summary.added) +
      list(t.deleted, a.summary.deleted) +
      (preview ? `<p><a href="${esc(preview.url)}" target="_blank" rel="noopener">${t.preview} ↗</a></p>` : '') +
      `<form method="post" class="actions">` +
      `<button class="btn" name="decision" value="approve" type="submit">${t.approve}</button>` +
      `<button class="btn secondary" name="decision" value="reject" type="submit">${t.reject}</button>` +
      `</form><p class="muted small">${t.undo}</p>`;
    res.type('html').send(page({ lang, title: t.title, body }));
  }

  /** POST /approve/:id  decision=approve|reject */
  async decide(req: Request, res: Response): Promise<void> {
    const lang = pickLang(req.get('accept-language'));
    noStore(res);
    const t = T[lang];
    const found = await this.load(String(req.params.id));
    if (!found) return this.message(res, lang, 404, t.expiredTitle, t.expiredBody);
    const { a, site } = found;
    // The session cookie is SameSite=Lax (never sent on cross-site POSTs); check the origin as well.
    // With Referrer-Policy: no-referrer browsers send "Origin: null" on form posts, so the page uses
    // same-origin, and Sec-Fetch-Site is accepted too.
    const origin = req.get('origin');
    const sameOrigin = origin === new URL(this.d.publicUrl).origin || req.get('sec-fetch-site') === 'same-origin';
    if (!sameOrigin || !this.hasSession(req, a)) return void res.status(403).type('html').send(page({ lang, title: t.expiredTitle, state: 'info', body: `<p>${t.expiredBody}</p>` }));
    if (a.status !== 'pending' || a.expires_at <= new Date()) return void res.redirect(303, `/approve/${a.id}`);

    const decision = (req.body as Record<string, unknown> | undefined)?.decision;
    if (decision === 'reject') {
      await this.d.pool.query(`UPDATE approvals SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'pending'`, [a.id]);
      await this.d.audit.add(site.id, a.client_id, 'publish_rejected', { approval_id: a.id });
      return void res.redirect(303, `/approve/${a.id}`);
    }
    if (decision !== 'approve') return void res.status(400).end();

    const fs = await this.d.openFs(site.id);
    try {
      const rel = await this.d.core.publish(a.draft_id, site.id, fs, a.client_id, a.draft_version);
      await this.d.pool.query(`UPDATE approvals SET status = 'approved', release_number = $2, decided_at = now() WHERE id = $1`, [a.id, rel.number]);
      await this.d.audit.add(site.id, a.client_id, 'publish', { release: rel.number, files: rel.files.map((f) => f.path), approved_in_browser: true, approval_id: a.id });
      return void res.redirect(303, `/approve/${a.id}`);
    } catch (e) {
      if (!(e instanceof DeployError)) throw e;
      if (e.code === 'not_previewed' || e.code === 'not_found' || e.code === 'expired') return this.message(res, lang, 409, t.expiredTitle, t.changedBody);
      if (e.code === 'conflict') return this.message(res, lang, 409, t.failedTitle, t.conflictBody);
      console.error('approved publish failed', e.code, e.message);
      return this.message(res, lang, 502, t.failedTitle, t.failedBody);
    } finally {
      await fs.close().catch(() => undefined);
    }
  }

  private async startSignIn(res: Response, a: ApprovalRow, site: Site): Promise<void> {
    const rid = randomToken(24);
    const binding = randomToken(32);
    await this.d.pool.query(
      `INSERT INTO approval_signins (rid, approval_id, binding_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [rid, a.id, hashToken(binding), SIGNIN_TTL_S],
    );
    const app = this.d.appName ? await this.d.appName(a.client_id) : 'CR Servers';
    const req = signReq(this.d.reqKey, {
      rid,
      app_name: app.slice(0, 60),
      app_host: new URL(this.d.publicUrl).host,
      exp: Math.floor(Date.now() / 1000) + SIGNIN_TTL_S,
      purpose: 'approve',
      service_id: site.serviceId,
    });
    res.cookie(BIND_COOKIE, binding, { httpOnly: true, secure: true, sameSite: 'lax', path: '/oauth', maxAge: SIGNIN_TTL_S * 1000 });
    res.redirect(302, `${this.d.clientAreaUrl}/index.php?cmd=crsconnect&req=${encodeURIComponent(req)}`);
  }

  /** GET /oauth/callback for a rid that belongs to an approval sign-in. */
  async callback(req: Request, res: Response): Promise<void> {
    const lang = pickLang(req.get('accept-language'));
    noStore(res);
    const t = T[lang];
    const rid = String(req.query.rid ?? '');
    const binding = readCookie(req.headers.cookie, BIND_COOKIE);
    res.clearCookie(BIND_COOKIE, { path: '/oauth' });
    const s = (await this.d.pool.query(
      `UPDATE approval_signins SET used_at = now() WHERE rid = $1 AND used_at IS NULL AND expires_at > now() RETURNING approval_id, binding_hash`,
      [rid],
    )).rows[0];
    if (!s || !binding || !safeEqual(Buffer.from(hashToken(binding)), Buffer.from(s.binding_hash))) return this.message(res, lang, 400, t.expiredTitle, t.expiredBody);
    const found = await this.load(s.approval_id);
    if (!found) return this.message(res, lang, 404, t.expiredTitle, t.expiredBody);
    // Not a redirect back to /approve: without a session that would start another sign-in.
    if (req.query.error || typeof req.query.code !== 'string') return this.message(res, lang, 400, t.notOwnerTitle, t.expiredBody);

    const ca = await this.d.clientArea.exchange(req.query.code, rid).catch((e: Error) => {
      console.error(JSON.stringify({ t: new Date().toISOString(), event: 'client_area_exchange_failed', error: e.message.slice(0, 300) }));
      return null;
    });
    if (!ca || ca.scope !== 'approve' || ca.account_id !== found.site.serviceId) return this.message(res, lang, 403, t.notOwnerTitle, t.notOwnerBody);

    const session = randomToken(32);
    await this.d.pool.query(`UPDATE approvals SET session_hash = $2, session_expires_at = now() + make_interval(secs => $3) WHERE id = $1`, [found.a.id, hashToken(session), SESSION_TTL_S]);
    res.cookie(SESSION_COOKIE, session, { httpOnly: true, secure: true, sameSite: 'lax', path: `/approve/${found.a.id}`, maxAge: SESSION_TTL_S * 1000 });
    res.redirect(303, `/approve/${found.a.id}`);
  }

  private message(res: Response, lang: Lang, status: number, title: string, body: string, state: 'ok' | 'info' = 'info'): void {
    res.status(status).type('html').send(page({ lang, title, state, body: `<p>${body}</p>` }));
  }
}

export function noStore(res: Response): void {
  res.set({ 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
}

export function readCookie(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
