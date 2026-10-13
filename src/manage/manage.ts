import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { noStore, readCookie } from '../approvals/approvals.js';
import type { ClientAreaApi } from '../auth/clientarea.js';
import { signReq } from '../auth/req.js';
import { hashToken, randomToken, safeEqual } from '../crypto.js';
import type { AuditLog } from '../deploy/pgstores.js';
import type { SiteRepo } from '../sites.js';
import { esc, type Lang, page, pickLang } from '../ui/page.js';

/**
 * "Asistente de IA" management page (docs/ARCHITECTURE.md, "Managing connections"):
 * /manage/<service id>. The owner signs in through the client area (the same owner check as the
 * approval link) and can see the AI assistants connected to the site, revoke them, see recent
 * activity, and turn "Aprobar cada publicación" on or off.
 */

const SIGNIN_TTL_S = 600;
const SESSION_TTL_S = 1800;
const BIND_COOKIE = 'crs_mbind';
const SESSION_COOKIE = 'crs_manage';

export interface ManageDeps {
  pool: Pool;
  sites: SiteRepo;
  audit: AuditLog;
  clientArea: ClientAreaApi;
  clientAreaUrl: string;
  reqKey: Buffer;
  publicUrl: string;
  revokeGrant: (grantId: string) => Promise<void>;
  appName?: (clientId: string) => Promise<string>;
}

const T = {
  es: {
    title: 'Asistente de IA',
    lead: (d: string) => `Asistentes de IA con acceso a <strong>${d}</strong>.`,
    none: 'Ningún asistente está conectado a este sitio.',
    howTo: 'Para conectar uno, agregue CR Servers en ChatGPT o Claude e inicie sesión con su cuenta de CR Servers.',
    connected: 'Conectado',
    lastUsed: 'Último uso',
    never: 'nunca',
    perm: { publish: 'Editar y publicar', preview: 'Solo vista previa' } as Record<string, string>,
    revoke: 'Quitar acceso',
    revokeAll: 'Quitar el acceso a todos',
    revoked: 'Acceso quitado.',
    approvalTitle: 'Aprobar cada publicación',
    approvalOn: 'Activado: cada publicación necesita su aprobación en el navegador.',
    approvalOff: 'Desactivado: el asistente publica cuando usted lo confirma en la conversación.',
    turnOn: 'Activar',
    turnOff: 'Desactivar',
    activity: 'Actividad reciente',
    noActivity: 'Sin actividad todavía.',
    actions: {
      start_changeset: () => 'Empezó un borrador',
      publish: (d: Record<string, unknown>) => `Publicó la versión #${d.release}${d.approved_in_browser ? ' (aprobada por usted)' : ''}`,
      revert: (d: Record<string, unknown>) => `Deshizo los cambios (versión #${d.release})`,
      approval_requested: () => 'Pidió su aprobación para publicar',
      publish_rejected: () => 'Usted decidió no publicar',
      connection_revoked: () => 'Se quitó el acceso a un asistente',
      settings_changed: (d: Record<string, unknown>) => (d.approve_every_publish ? 'Se activó «Aprobar cada publicación»' : 'Se desactivó «Aprobar cada publicación»'),
    } as Record<string, (d: Record<string, unknown>) => string>,
    by: 'por',
    you: 'usted',
    siteMissing: 'Este sitio todavía no tiene la publicación con IA activada. Se activa sola la primera vez que conecta un asistente.',
    expiredTitle: 'La sesión expiró',
    expiredBody: 'Vuelva a abrir esta página desde el área de clientes.',
    notOwnerTitle: 'No se pudo verificar',
    notOwnerBody: 'La cuenta con la que inició sesión no administra este sitio.',
  },
  en: {
    title: 'AI assistant',
    lead: (d: string) => `AI assistants with access to <strong>${d}</strong>.`,
    none: 'No assistant is connected to this site.',
    howTo: 'To connect one, add CR Servers in ChatGPT or Claude and sign in with your CR Servers account.',
    connected: 'Connected',
    lastUsed: 'Last used',
    never: 'never',
    perm: { publish: 'Edit and publish', preview: 'Preview only' } as Record<string, string>,
    revoke: 'Remove access',
    revokeAll: 'Remove access for all',
    revoked: 'Access removed.',
    approvalTitle: 'Approve every publish',
    approvalOn: 'On: every publish needs your approval in the browser.',
    approvalOff: 'Off: the assistant publishes once you confirm in the conversation.',
    turnOn: 'Turn on',
    turnOff: 'Turn off',
    activity: 'Recent activity',
    noActivity: 'No activity yet.',
    actions: {
      start_changeset: () => 'Started a draft',
      publish: (d: Record<string, unknown>) => `Published release #${d.release}${d.approved_in_browser ? ' (approved by you)' : ''}`,
      revert: (d: Record<string, unknown>) => `Undid changes (release #${d.release})`,
      approval_requested: () => 'Asked for your approval to publish',
      publish_rejected: () => 'You chose not to publish',
      connection_revoked: () => 'An assistant’s access was removed',
      settings_changed: (d: Record<string, unknown>) => (d.approve_every_publish ? '“Approve every publish” turned on' : '“Approve every publish” turned off'),
    } as Record<string, (d: Record<string, unknown>) => string>,
    by: 'by',
    you: 'you',
    siteMissing: 'AI publishing isn’t active for this site yet. It turns on by itself the first time you connect an assistant.',
    expiredTitle: 'Your session expired',
    expiredBody: 'Open this page again from the client area.',
    notOwnerTitle: "Couldn't verify",
    notOwnerBody: "The account you signed in with doesn't manage this site.",
  },
} as const;

const fmt = (d: Date, lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'es' ? 'es-CR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Costa_Rica' }).format(d);

export class ManageService {
  constructor(private readonly d: ManageDeps) {}

  async ownsRid(rid: unknown): Promise<boolean> {
    if (typeof rid !== 'string' || !rid) return false;
    return (await this.d.pool.query('SELECT 1 FROM manage_signins WHERE rid = $1', [rid])).rowCount === 1;
  }

  private serviceId(req: Request): number | null {
    const n = Number(req.params.serviceId);
    return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
  }

  private async session(req: Request, serviceId: number): Promise<boolean> {
    const s = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!s) return false;
    const r = await this.d.pool.query('SELECT 1 FROM manage_sessions WHERE token_hash = $1 AND service_id = $2 AND expires_at > now()', [hashToken(s), serviceId]);
    return r.rowCount === 1;
  }

  /** GET /manage/:serviceId */
  async show(req: Request, res: Response): Promise<void> {
    const lang = pickLang(req.get('accept-language'));
    noStore(res);
    const serviceId = this.serviceId(req);
    if (!serviceId) return void res.status(404).end();
    if (!(await this.session(req, serviceId))) return this.startSignIn(res, serviceId);

    const t = T[lang];
    const site = await this.d.sites.byAccount(serviceId);
    if (!site) return void res.type('html').send(page({ lang, title: t.title, body: `<p>${t.siteMissing}</p>` }));

    const grants = (await this.d.pool.query(
      `SELECT g.id, g.client_id, g.permission, g.created_at,
              (SELECT max(created_at) FROM tokens k WHERE k.grant_id = g.id AND k.kind = 'access') AS last_used
       FROM grants g WHERE g.site_id = $1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`,
      [site.id],
    )).rows;
    const names = new Map<string, string>();
    const name = async (id: string) => {
      if (id === 'owner') return t.you;
      if (!names.has(id)) names.set(id, this.d.appName ? await this.d.appName(id) : id);
      return names.get(id)!;
    };

    let list = '';
    for (const g of grants) {
      list +=
        `<li class="row"><div><strong>${esc(await name(g.client_id))}</strong> · ${t.perm[g.permission] ?? esc(g.permission)}<br>` +
        `<span class="muted small">${t.connected}: ${fmt(g.created_at, lang)} · ${t.lastUsed}: ${g.last_used ? fmt(g.last_used, lang) : t.never}</span></div>` +
        `<form method="post" action="/manage/${serviceId}/revoke"><input type="hidden" name="grant" value="${esc(g.id)}"><button class="btn secondary" type="submit">${t.revoke}</button></form></li>`;
    }
    const connections = grants.length
      ? `<ul class="rows">${list}</ul>${grants.length > 1 ? `<form method="post" action="/manage/${serviceId}/revoke"><input type="hidden" name="grant" value="all"><button class="btn secondary" type="submit">${t.revokeAll}</button></form>` : ''}`
      : `<p>${t.none}</p><p class="muted small">${t.howTo}</p>`;

    const approval =
      `<h2>${t.approvalTitle}</h2><p class="small">${site.approveEveryPublish ? t.approvalOn : t.approvalOff}</p>` +
      `<form method="post" action="/manage/${serviceId}/settings"><input type="hidden" name="approve_every_publish" value="${site.approveEveryPublish ? 'off' : 'on'}">` +
      `<button class="btn secondary" type="submit">${site.approveEveryPublish ? t.turnOff : t.turnOn}</button></form>`;

    const events = await this.d.audit.recent(site.id, 15);
    let activity = '';
    for (const e of events) {
      const label = t.actions[e.action]?.(e.detail) ?? esc(e.action);
      activity += `<li><span class="muted small">${fmt(e.at, lang)}</span><br>${label} <span class="muted small">${t.by} ${esc(await name(e.clientId))}</span></li>`;
    }

    const notice = req.query.done === 'revoked' ? `<p class="notice">${t.revoked}</p>` : '';
    res.type('html').send(
      page({
        lang,
        title: t.title,
        body:
          notice +
          `<p>${t.lead(esc(site.domain))}</p>${connections}${approval}` +
          `<h2>${t.activity}</h2>${activity ? `<ul class="activity">${activity}</ul>` : `<p class="muted small">${t.noActivity}</p>`}`,
      }),
    );
  }

  /** POST /manage/:serviceId/revoke  grant=<id>|all */
  async revoke(req: Request, res: Response): Promise<void> {
    const serviceId = await this.guardPost(req, res);
    if (!serviceId) return;
    const site = await this.d.sites.byAccount(serviceId);
    const grant = String((req.body as Record<string, unknown>)?.grant ?? '');
    if (site && grant) {
      const ids = (await this.d.pool.query(
        grant === 'all'
          ? 'SELECT id, client_id FROM grants WHERE site_id = $1 AND revoked_at IS NULL'
          : 'SELECT id, client_id FROM grants WHERE site_id = $1 AND revoked_at IS NULL AND id::text = $2',
        grant === 'all' ? [site.id] : [site.id, grant],
      )).rows;
      for (const g of ids) {
        await this.d.revokeGrant(g.id);
        await this.d.audit.add(site.id, g.client_id, 'connection_revoked', { grant_id: g.id, by: 'owner' });
      }
    }
    res.redirect(303, `/manage/${serviceId}?done=revoked`);
  }

  /** POST /manage/:serviceId/settings  approve_every_publish=on|off */
  async settings(req: Request, res: Response): Promise<void> {
    const serviceId = await this.guardPost(req, res);
    if (!serviceId) return;
    const on = (req.body as Record<string, unknown>)?.approve_every_publish === 'on';
    const r = await this.d.pool.query('UPDATE sites SET approve_every_publish = $2 WHERE service_id = $1 RETURNING id', [serviceId, on]);
    if (r.rows[0]) await this.d.audit.add(r.rows[0].id, 'owner', 'settings_changed', { approve_every_publish: on });
    res.redirect(303, `/manage/${serviceId}`);
  }

  /** Same-origin form post from a signed-in owner of this service; otherwise answers and returns null. */
  private async guardPost(req: Request, res: Response): Promise<number | null> {
    noStore(res);
    const lang = pickLang(req.get('accept-language'));
    const serviceId = this.serviceId(req);
    const origin = req.get('origin');
    const sameOrigin = origin === new URL(this.d.publicUrl).origin || req.get('sec-fetch-site') === 'same-origin';
    if (!serviceId || !sameOrigin || !(await this.session(req, serviceId))) {
      res.status(403).type('html').send(page({ lang, title: T[lang].expiredTitle, state: 'info', body: `<p>${T[lang].expiredBody}</p>` }));
      return null;
    }
    return serviceId;
  }

  private async startSignIn(res: Response, serviceId: number): Promise<void> {
    const rid = randomToken(24);
    const binding = randomToken(32);
    await this.d.pool.query(
      `INSERT INTO manage_signins (rid, service_id, binding_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [rid, serviceId, hashToken(binding), SIGNIN_TTL_S],
    );
    // The client area's owner check (purpose "approve"): signed-in client must own this active service.
    const req = signReq(this.d.reqKey, {
      rid,
      app_name: 'CR Servers',
      app_host: new URL(this.d.publicUrl).host,
      exp: Math.floor(Date.now() / 1000) + SIGNIN_TTL_S,
      purpose: 'approve',
      service_id: serviceId,
    });
    res.cookie(BIND_COOKIE, binding, { httpOnly: true, secure: true, sameSite: 'lax', path: '/oauth', maxAge: SIGNIN_TTL_S * 1000 });
    res.redirect(302, `${this.d.clientAreaUrl}/index.php?cmd=crsconnect&req=${encodeURIComponent(req)}`);
  }

  /** GET /oauth/callback for a rid that belongs to a management sign-in. */
  async callback(req: Request, res: Response): Promise<void> {
    const lang = pickLang(req.get('accept-language'));
    noStore(res);
    const t = T[lang];
    const rid = String(req.query.rid ?? '');
    const binding = readCookie(req.headers.cookie, BIND_COOKIE);
    res.clearCookie(BIND_COOKIE, { path: '/oauth' });
    const s = (await this.d.pool.query(
      `UPDATE manage_signins SET used_at = now() WHERE rid = $1 AND used_at IS NULL AND expires_at > now() RETURNING service_id, binding_hash`,
      [rid],
    )).rows[0];
    const fail = (status: number, title: string, body: string) => void res.status(status).type('html').send(page({ lang, title, state: 'info', body: `<p>${body}</p>` }));
    if (!s || !binding || !safeEqual(Buffer.from(hashToken(binding)), Buffer.from(s.binding_hash))) return fail(400, t.expiredTitle, t.expiredBody);
    if (req.query.error || typeof req.query.code !== 'string') return fail(400, t.notOwnerTitle, t.expiredBody);
    const ca = await this.d.clientArea.exchange(req.query.code, rid).catch((e: Error) => {
      console.error(JSON.stringify({ t: new Date().toISOString(), event: 'client_area_exchange_failed', error: e.message.slice(0, 300) }));
      return null;
    });
    if (!ca || ca.scope !== 'approve' || ca.account_id !== s.service_id) return fail(403, t.notOwnerTitle, t.notOwnerBody);

    const session = randomToken(32);
    await this.d.pool.query(
      `INSERT INTO manage_sessions (token_hash, service_id, account_holder_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [hashToken(session), s.service_id, ca.client_id, SESSION_TTL_S],
    );
    res.cookie(SESSION_COOKIE, session, { httpOnly: true, secure: true, sameSite: 'lax', path: `/manage/${s.service_id}`, maxAge: SESSION_TTL_S * 1000 });
    res.redirect(303, `/manage/${s.service_id}`);
  }
}
