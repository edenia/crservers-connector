# CR Servers connector: spec (draft v0.5)

**Status:** Proposal only. Nothing in this document is built or shipped.
**Date:** 2026-10-10 (v0.5: spikes 0b and 0d folded in, Q5 decided · v0.4: pilot hosts known, Q5 recommendation · v0.3: P1–P4 decided · v0.2: same day · v0.1: 2026-10-07) · **Owner:** Xavier (decisions) · **Tracking:** internal issue tracker (pilot details and client data stay there, not in this public repo)
**Scope:** Level 2 of the "build your site with AI" plan. The AI assistant a client already pays for (ChatGPT, Claude, maybe Gemini) gets a safe, limited way to publish and maintain that client's site on CR Servers shared hosting (InterWorx/SiteWorx). The client needs no GitHub, no FTP and no developer.

> **TL;DR:** We build one small CR Servers service. It exposes a **remote MCP server** (the standard that ChatGPT plugins and Claude connectors both speak) and an **OAuth server whose sign-in step is a custom HostBill client-area plugin**, so we never see a password. Behind it sits a deploy core that stages changes, shows a preview, and **records the previous version of every file a publish touches**, so any publish can be reverted with one call or one tap. That core writes only to the client's web root, using a per-site FTP account that cannot leave it. It's free with every shared hosting plan. Level 1 (pre-made prompts plus an upload page) runs on the same core.

---

## 0. Changes from v0.1

**Applied from Xavier's decisions of 2026-10-07:**
- **Login:** custom HostBill client-area plugin. HostBill handles login, MFA and brute-force bans. The `verifyClientLogin` route is dropped.
- **Pricing:** free with every shared hosting plan. No "IA Pro" add-on, no dedicated plan.
- **No full pre-publish snapshots**, so no snapshot retention policy and no snapshot bucket sizing.
- **Hosting:** existing Kubernetes cluster at `connect.crservers.com`, with its own repo and deploy pipeline.
- **Publishing identity:** Sistemas Edenia Internacional S.A. (CR Servers is a brand of that company).
- **Listing:** public in the ChatGPT plugin directory from beta.
- **Support:** the HostBill support ticket team.
- **Contact form** comes from the Edenia static deploy repo (`static-site-contact/`). The GitHub Action path stays available alongside the AI connectors.

**Proposals added in v0.2, accepted by Xavier on 2026-10-10 (v0.3).** They're marked **[P1]–[P4]** where they appear:
- **[P1] Revert records instead of snapshots.** At publish time, keep only the previous version of each file that publish overwrites or deletes. It's small and gives a real undo. *Accepted with a smaller history: the last 5 releases per site.* This refines the "no snapshots" decision. Reasons are in §5.
- **[P2] PHP only through managed components.** Static files by default. The AI can turn on vetted server-side components (the contact form first) but can't write arbitrary `.php`. Raw PHP becomes a later opt-in setting per site. *Accepted. This narrows the "PHP allowed" decision.* Reasons are in §5.
- **[P3] Component provisioning is a separate step.** The contact form needs files outside the web root and a pre-built `vendor/`, which the jailed deploy FTP account can't write. *Accepted.* See §6, decision 7.
- **[P4] Conflict detection and one publish at a time per site.** A publish is refused if the live site changed since the draft read it. *Accepted.*
- **Q5** was settled in v0.5 (see below and §5 Confirmation).

**Changes in v0.5 (2026-10-10), from spikes 0b and 0d:**
- **Q5 decided:** host confirmation + revert record + **mandatory** server-side guards (publish only a previewed draft; approval link for big changes). "Aprobar cada publicación" stays opt-in, off by default.
- **Sign-in host** is `clients.crservers.com` (the production client area), not `my.crservers.com`.
- **Code exchange** uses an opaque one-time code stored by the HostBill plugin and redeemed through the plugin's own API function. The `req` HMAC only authenticates connector → plugin (§5, Login; §6, decision 2).
- **No secrets in tool inputs** (OpenAI plugin rules): component secrets are entered on the manage page only, and `enable_component` stays out of the first directory submission.
- **Read tools are truly read-only:** the conflict-check base moves from `read_file` to `start_changeset` / `write_files`.
- **Tool annotations** are explicit for every tool, with corrections for preview, discard, upload and replace-all.
- **OAuth for ChatGPT:** RFC 9207 `iss`, `offline_access`, ChatGPT's exact redirect URIs.
- **ChatGPT directory reality:** public release only (country-limited to CR as the soft launch), the MCP URL is locked once submitted, review takes about 1–3 weeks, a no-MFA reviewer account is required. OpenAI business verification is **already approved**.

---

## 1. Problem, users, goals

**Trigger.** A CR Servers client built and runs a bilingual catalog site with ChatGPT on our shared hosting, working mostly from a phone. The assistant had no authorized way to reach the hosting, so the client ended up copy-pasting code from the phone. What they asked for: a compatible, secure way to publish changes, with limited permissions, backups and the ability to restore. They offered to pilot.

The pilot site is plain static HTML (one large `index.html`, images and several **MP4 videos**), which sets the v1 baseline: static files, media-heavy, edited from a phone.

**Users**
| User | Situation | What they need |
|---|---|---|
| PYME owner (primary) | Has a ChatGPT/Claude account and a CR Servers hosting plan. Works from a phone. Not technical. Spanish first. | "Tell my AI to update the site" works, is safe, and can be undone. |
| Freelancer / agency | Manages a few client sites with AI | Several sites, limited per-site access, an activity log |
| CR Servers support (HostBill ticket team) | Small team | Few tickets. Clients fix their own mistakes with revert. A runbook for the rest. |
| Xavier | Owner/CTO | Self-serve adoption, no meetings, no midnight tickets |

**Goals**
1. Connect an AI to one CR Servers site in under 3 minutes from a phone, with no passwords pasted into the chat or typed into our pages.
2. The AI can read, stage, preview, publish and revert files in **that site's web root only**.
3. **Every publish and every revert can be undone** with one tool call or one tap, for the last 5 publishes [P1]. Older restores go through the InterWorx nightly/weekly backups via a support ticket.
4. A client can see everything the AI did (activity log) and revoke access at any time.
5. Near-zero ops: one container, one database, one small bucket, no per-client manual steps after beta.

**Non-goals (v1)**
- No shell/SSH, no cron, no databases, no email, DNS, SSL or billing changes, and no access to other sites on the account.
- **Static by default [P2]:** HTML, CSS, JS, images, media and static-export builds. Server-side code arrives only as **managed components** that our code installs and upgrades. The contact form from [crservers-static-deploy](https://github.com/edenia/crservers-static-deploy) `static-site-contact/` is the first. The AI can switch a component on and configure it, but **can't upload or edit `.php` files**. Raw PHP uploads are a later opt-in setting per site, after beta, with its own scanning rules.
- WordPress is out of scope for v1. It's a separate later decision, likely through WP's own APIs rather than file writes.
- No building or running client code on our side. If the AI wants a framework build, it uploads the built output.
- No full-site snapshots. The InterWorx nightly/weekly backups remain the disaster-recovery layer.

---

## 2. Platform reality check (Oct 2026)

This table decides the design. Sources are in References. (Updated in v0.5 with spike 0b.)

| AI host | How a third party plugs in | Works on the phone? | Plans | Implication |
|---|---|---|---|---|
| **ChatGPT, published plugin** (Plugins directory) | Plugin = remote MCP server + optional skills/UI. Submitted to OpenAI and reviewed [R1–R4] | **Yes.** Plugins are usable from mobile via @mention. Directory guidelines require plugins to work on desktop *and* mobile [R2, R4] | Directory available across plans. Installing depends on plan, region and workspace [R2] | **The only reliable ChatGPT mobile path.** Public release only: there's no private or unlisted listing, so the soft launch is `countries: ["CR"]` plus search-only discovery [R33]. Review takes about 1–3 weeks with no SLA [R34]. The MCP URL can't change after submission [R33]. Business verification for Sistemas Edenia Internacional S.A. is approved. |
| ChatGPT, custom MCP added by the user | chatgpt.com/plugins → Add custom MCP server (OAuth supported) [R3, R5] | **No, web only** (Help Center FAQ) [R5] | Full MCP **incl. write actions: beta for Business/Enterprise/Edu**. Pro: read/fetch in developer mode [R5]. Staff say the dev-mode toggle was removed for "eligible users" [R6]; personal-plan write support is **unclear, so spike it** | Fine for the pilot on desktop web (Business plans) and for our own testing. OpenAI points private use here rather than to the directory [R34]. Not the mobile answer. |
| ChatGPT, custom GPT + Actions (OpenAPI + OAuth) | — | Actions on mobile have open bug reports [R8] | **New GPT creation is off for Free/Go/Plus/Pro. Custom GPTs are being retired in favour of Plugins** (Enterprise retirement planned Dec 11, 2026) [R7] | **Don't build a GPT Action.** We keep an OpenAPI description of our REST API for our own pages only. |
| **Claude, custom connector** (remote MCP + OAuth) | Add by URL in Customize → Connectors. Supports DCR and Client ID Metadata Docs. Callback `https://claude.ai/api/mcp/auth_callback` [R9–R11] | **Yes:** connectors work in the iOS/Android apps. *Adding* one on mobile is beta; web/desktop is the primary setup path [R10] | Free (1 custom connector), Pro, Max, Team, Enterprise [R9] | **Best pilot path today.** No review needed. |
| Gemini, custom apps (MCP) | Add MCP URL in gemini.google.com → Connected Apps [R12, R13] | Add on web, then usable in the mobile app [R12] | **US-only, 18+, English, personal account, Keep Activity on.** The Spark workflows need AI Pro/Ultra [R12, R14] | **Not usable for Costa Rican clients today.** Level 1 prompts only. Re-check quarterly. |

**Conclusion:** build **one remote MCP server** with spec-compliant OAuth. That one server is the Claude connector, the ChatGPT plugin and (later) the Gemini custom app. Anything that can't connect falls back to Level 1 (prompt + upload link).

---

## 3. User flow (from a phone)

**A. Discover.** A blog post, a KB page, the HostBill client area ("Conecte su asistente de IA") or the AI itself (ChatGPT directory search for "CR Servers") points to `crservers.com/ia`. The page has one button per AI with 3–4 screenshots each, ES and EN.

**B. Connect (once, about 2 minutes)**
1. **Claude:** paste `https://connect.crservers.com/mcp` into Connectors → Add custom connector. **ChatGPT:** install the "CR Servers" plugin from the directory, or for the pilot add the custom MCP URL on web.
2. The AI app opens our authorize URL, which **redirects to the HostBill client area** (`clients.crservers.com/index.php?cmd=crsconnect&req=<signed id>`):
   - The client signs in **on HostBill itself**, with HostBill's own 2FA and brute-force protection. Clients already signed in skip this step.
   - The plugin page (crservers.com branding, Spanish by default) asks them to **pick the site**, e.g. `misitio.cr`. Only active InterWorx hosting services owned by this client are listed.
   - They pick the permission: **"Ver y editar con vista previa"** (stage and preview only) or **"Editar y publicar"** (default).
   - The page shows *which app* is asking (client name and redirect host, e.g. "Claude, claude.ai") and what it **can't** do (email, DNS, billing, other sites).
3. HostBill redirects back to the connector with a one-time code. The connector finishes the OAuth flow, and the chat shows "Conectado a misitio.cr ✅".

**C. First publish**
> User: "Cambie el precio del lote 1000 a $45.000 y agregue estas 3 fotos."
1. The AI calls `get_site_info`, `start_changeset` (which records the live hash of every file as the draft's base), `read_file index.html`, then `write_files` with the edited HTML.
2. Photos and videos: ChatGPT can hand files the user attached straight to our tool [R4]. On any AI, the AI can call `create_upload_link`, and the user taps it and picks photos from the gallery into the same change set.
3. `preview_changeset` returns a private preview link plus a plain-language diff ("1 archivo modificado, 3 imágenes nuevas, escaneo OK"). The user taps the link and checks it on the phone.
4. User: "Publíquelo." The AI calls `publish`. The server only accepts a draft that was previewed in its current form. The AI host shows its own confirmation for a destructive tool, and the user approves.
5. The server checks that the live files haven't changed since the draft [P4], saves the revert record [P1], publishes, and returns "Publicado como versión #14. Para deshacer diga 'revierta la versión #14'."

**D. Undo.** "Se dañó la página, vuelva a como estaba antes del último cambio." The AI calls `list_releases`, then `revert_release`, with confirmation. A revert is itself a release with its own revert record, so it can be undone too. If the AI isn't available, the client can do the same with **one tap** on `crservers.com/ia/sitios` (the shared Level 1 page). For anything older than the last 5 publishes, or damage not made through the connector, the page links to a pre-filled HostBill support ticket asking for an InterWorx backup restore.

**E. Manage.** The same page lists connected AIs per site, the activity log, releases with a revert button, enabled components and a **Revocar acceso** button. It's also linked from the HostBill client area.

---

## 4. Tool surface for the AI (MCP)

All tools are site-scoped: the token only works for the sites picked at consent. Every tool sets all three annotations explicitly, with a one-line justification in the submission [R4, R15, R33]. `openWorldHint` is true when a tool makes content public.

| Tool | Does | Key inputs → outputs | readOnly | destructive | openWorld | Confirmation |
|---|---|---|---|---|---|---|
| `list_sites` | Sites this token can touch | — → `[{site_id, domain}]` | ✅ | ❌ | ❌ | no |
| `get_site_info` | Domain, live URL, disk used/quota, last publish, current release, permission level, enabled components | `site_id` → object | ✅ | ❌ | ❌ | no |
| `get_usage_limits` | Remaining publishes/day, size caps, allowed file types | `site_id` → object | ✅ | ❌ | ❌ | no |
| `list_files` | Tree of the live site or a change set | `site_id`, `path`, `source=live\|changeset`, `cursor` → entries with size, hash | ✅ | ❌ | ❌ | no |
| `read_file` | Text content (≤1 MB). Binary returns metadata and hash only. **No side effects** | `site_id`, `path`, `source` → `{content, encoding, hash}` | ✅ | ❌ | ❌ | no |
| `start_changeset` | Opens a staged draft based on live (expires after 24 h) and records the live hash of every file as the draft's base [P4] | `site_id`, `note` → `changeset_id` | ❌ | ❌ | ❌ | no (touches nothing live) |
| `write_files` | Adds or overwrites files **in the draft**. Optional `base_hash` per path overrides the recorded base | `changeset_id`, `files[{path, content, encoding: utf8\|base64, base_hash?}]` (≤50 files / 5 MB per call) → per-file result | ❌ | ❌ | ❌ | no |
| `add_attachments` | Adds files the user attached in ChatGPT (photos, videos) to the draft. Fetched server-side immediately | `changeset_id`, `files[{download_url, file_id, mime_type, file_name}]` (ChatGPT file params, `_meta["openai/fileParams"]` [R4]), `target_dir` | ❌ | ❌ | ❌ | no |
| `delete_files` | Marks paths for deletion **in the draft** | `changeset_id`, `paths[]` | ❌ | ❌ | ❌ | no |
| `merge_bundle` | Merges a ZIP into the draft | `changeset_id`, `file{download_url, file_id, mime_type, file_name}` | ❌ | ❌ | ❌ | no |
| `replace_with_bundle` | Replaces the whole draft with a ZIP's contents | same as `merge_bundle` | ❌ | ✅ | ❌ | yes. Publishing it always needs the approval link (§5) |
| `create_upload_link` | Short-lived (15 min) phone upload page for photos, videos or a ZIP into the draft | `changeset_id` → `url` | ❌ | ❌ | ❌ | no |
| `preview_changeset` | Runs scans and the conflict check, builds a private preview, plain diff summary. Marks the current draft version as previewed | `changeset_id` → `{preview_url, summary, scan:{ok, findings[]}, conflicts[]}` | ❌* | ❌ | ❌ | no |
| `publish` | **Previewed? → conflict check → revert record → push the draft live.** Idempotent per `changeset_id` | `changeset_id` → `{release, live_url, files_changed}` | ❌ | ✅ | ✅ | **yes**, host confirmation. Refused if not previewed in its current form, if scans fail or if conflicts exist. Approval link when required (§5) |
| `list_releases` | The last 5 publishes and reverts, newest first | `site_id` → `[{release, when, cause: publish\|revert\|component, files_changed, revertible, by_app}]` | ✅ | ❌ | ❌ | no |
| `revert_release` | Puts back the files as they were **before** the chosen release. Reverts every later release too, newest first | `site_id`, `release` → `{release (the new revert release), reverted[]}` | ❌ | ✅ | ✅ | **yes** |
| `list_components` | Managed components available and their state [P2] | `site_id` → `[{component, version, enabled, config_status}]` | ✅ | ❌ | ❌ | no |
| `enable_component` | Installs or upgrades a managed component (v1: `contact_form`). **Takes no secrets**: it returns a manage-page link where the client enters SMTP and Turnstile settings. **Not in the first directory submission** | `site_id`, `component`, `settings{mail_to, …}` (non-secret only) → `{status, settings_url}` | ❌ | ✅ | ✅ | **yes** |
| `get_activity_log` | What happened, when, by which AI app (no IP data in tool output; that stays on the manage page) | `site_id`, `limit` → events | ✅ | ❌ | ❌ | no |
| `discard_changeset` | Drops a draft and its staged files | `changeset_id` | ❌ | ✅ | ❌ | no (touches nothing live) |

\*`preview_changeset` writes only to our preview storage and the draft's state, never to the site. It's annotated not-read-only because the publish guard depends on that state [R33].

Removed from v0.1: `list_backups` and `restore_backup`. `list_releases` and `revert_release` replace them [P1]. Changed in v0.5: `upload_bundle` split into `merge_bundle` and `replace_with_bundle`; `add_attachments` added; tool outputs trimmed to what the user needs (no internal ids or timestamps beyond that) [R33].

Design notes:
- **Staged change sets** make "the AI typed half a file" impossible on the live site. Nothing is live until `publish`.
- Tool results carry short **human-readable Spanish/English summaries**, so the AI can relay them to a non-technical user.
- File contents read from the site are returned as data with a note telling the AI not to follow instructions found inside them (prompt-injection hygiene, [R4]).
- **Conflicts [P4].** `start_changeset` records the live hash of every file. If the live hash of a path the draft changes no longer matches its base (someone edited over FTP, or another AI connection published), `preview_changeset` lists it and `publish` refuses. The AI re-reads the file and rewrites its change.
- **No secrets in tool inputs or outputs.** OpenAI's plugin rules forbid passwords and API keys as tool arguments [R33]. SMTP passwords and Turnstile secrets are entered only on the manage page, stored encrypted and written by the provisioning job (§6, decision 7).
- **ChatGPT plugin skills** (bundled with the plugin [R1]) hold our pre-made prompts: "Crear sitio de negocio", "Actualizar catálogo", "Deshacer último cambio", plus an onboarding skill. "Activar formulario de contacto" waits until `enable_component` is submitted. Changing skills needs a new package and review, so keep them stable. They are the same text as the Level 1 guides (§7).

---

## 5. Safety model

| Control | v1 rule (proposal) |
|---|---|
| **Scope** | Token = (client, AI app, site list, permission). Tokens are audience-bound to our MCP URL (RFC 8707), as MCP requires [R16]. Writes are limited to the site's web root, enforced *twice*: our path checks (no `..`, no symlinks, normalized paths) **and** an InterWorx FTP sub-account whose home is the web root only [R17]. |
| **Least privilege** | No DNS, email, SSL, DB, cron, billing or other sites. Tokens never reach InterWorx/HostBill (no token passthrough [R16]). The HostBill Admin API key the connector uses can only call the plugin's exchange function (if HostBill allows that narrow a scope; otherwise as few calls as possible) and is locked to the connector's egress IP [R29]. The client area sits behind a CDN/WAF, so the IP lock must be verified to see the real caller IP, and the connector's calls need an explicit allow rule. |
| **Login** | Done entirely inside HostBill by the `crsconnect` client-area plugin: HostBill's own password check, MFA and bans. Our `/authorize` step creates a signed `req` (HMAC; carries the request id and the asking app's name and host, so the consent page can't be spoofed) and sets a browser-binding cookie on `connect.crservers.com`. After consent, the plugin returns an **opaque one-time code**: 32 random bytes, stored only as a hash in HostBill, expires in 60 s on HostBill's clock, single use, tied to the request id. The connector redeems it server-to-server through the plugin's own API function, which **re-checks** that the client owns the chosen service, that it's active and that it's InterWorx hosting. The callback also requires the browser-binding cookie, so a victim can't be tricked into linking their site to an attacker's AI client. HostBill Auto Login and the User API were considered and rejected (shared secret that can impersonate any client; password-only auth with no scopes) [R30, R31]. |
| **Tokens** | OAuth 2.1 + PKCE S256 at the connector, which stays the full authorization server for Claude/ChatGPT (PRM, AS metadata, CIMD, DCR). HostBill is only the upstream sign-in step. Authorization responses carry the RFC 9207 `iss` parameter (`authorization_response_iss_parameter_supported: true`), and the PRM `issuer` matches exactly. `offline_access` is listed in `scopes_supported`. Redirect allowlist: Claude's callback and ChatGPT's (`https://chatgpt.com/connector_platform_oauth_redirect` plus the exact URI shown in OpenAI's dashboard) [R11, R35]. DCR-registered clients don't expire. Access token 1 h. Rotating refresh token, 90-day idle expiry. Revocable per connection. |
| **File types [P2]** | Allow: `html htm css js mjs json xml txt md svg png jpg jpeg webp gif avif ico woff woff2 ttf otf mp4 webm mp3 pdf webmanifest` plus `robots.txt`, `sitemap.xml`, `/.well-known/*`. **Block for AI writes:** `php phtml phar cgi pl py sh exe`, `.user.ini`, `.env`, dotfiles, archives inside the site. Paths owned by an enabled component (`contact.php`, `vendor/`) are **read-only to the AI** and changed only by the component installer. `.htaccess` is blocked in v1. Later, a template tool offers vetted rules (redirects, caching, HTTPS). |
| **Why no raw PHP in v1 [P2]** | Arbitrary PHP from an AI means code execution on a shared node. One prompt injection in a file the AI reads could plant a webshell, a phishing kit or a `mail()` spam relay. CageFS limits the blast radius, but not the abuse or the blacklisting of the node's IP. Managed components give clients the server-side features they actually ask for (forms first) without that risk. |
| **Size / rate** | ≤25 MB per file (≤100 MB for mp4/webm), ≤200 MB and ≤2,000 files per change set, ≤30 publishes/day, ≤300 write calls/hour per site, all within the plan's disk quota. Limits are visible through `get_usage_limits`. |
| **Scans before preview/publish** | ClamAV on all files. Secret scan (private keys, API-key patterns, passwords in JS). JS heuristics (cryptominer domains, `eval` of long base64). Phishing heuristics (password forms posting off-site, bank brand names). A **hard fail** blocks publish. Warnings are shown in the preview summary. |
| **Revert records [P1]** | Before a publish changes anything live, the connector downloads and stores the **current version of every file the change set overwrites or deletes** (new files only need their path). Stored in our bucket, not counted against the client's quota. Keep the **last 5 releases per site**, with no time limit. A typical catalog edit stores a few hundred KB. Each release keeps a manifest of the hashes it wrote. |
| **Why revert records and not "InterWorx backups only"** | Using only the nightly/weekly backups would mean: (1) everything published since the last nightly is lost on restore; (2) a SiteWorx partial restore can include mail and databases [R27], so an AI-triggered restore could roll back someone's email; (3) restoring through the API needs the SiteWorx reseller key, which decision 5 keeps out of the publish path; (4) publish isn't atomic (§6, decision 3), so a failure halfway would leave a half-updated site with nothing to roll back to. The pilot client asked for backups and restore specifically. Revert records answer that at a fraction of a snapshot's cost. InterWorx backups remain the disaster-recovery layer, reached through a support ticket. |
| **Revert rules** | `revert_release(N)` restores the files to their state before release N by applying the revert records of the latest release down to N, newest first. Before reverting, the connector checks that the live hashes still match what those releases wrote. If they don't (manual FTP edits since), it refuses and lists the files. The revert is recorded as a new release, so it can be undone too. |
| **Publish failure handling** | Phase 1: upload everything to temporary names. If any upload fails, the temporary files are deleted and nothing live has changed. Phase 2: rename into place, then delete removed files last. If phase 2 fails, the connector automatically applies the revert record for the paths already changed, then reports the failure. |
| **Concurrency [P4]** | One publish or revert at a time per site (database lock). Conflict check on every publish (see §4 design notes). Drift check: list the live tree (size + mtime over MLSD) against the last release manifest, and re-hash only the files that look changed. |
| **Preview** | Private random URL (`preview.crservers.com/<128-bit id>/`), `noindex`, expires with the change set. Served by our service from staged files (static only; component pages show a placeholder). |
| **Confirmation (Q5, decided)** | `publish`, `revert_release`, `replace_with_bundle` and `enable_component` are annotated destructive, so ChatGPT and Claude ask the user [R5, R10]. Users on personal ChatGPT accounts can choose to always allow a tool, so the host confirmation can disappear [R36]. The server therefore enforces two **mandatory** guards: (1) **publish only a previewed draft**: `publish` is refused unless `preview_changeset` ran on the draft's current version, and any later write requires a new preview; (2) an **approval link** the client taps (signed in) when a change deletes more than 50% of the files or replaces the whole site. With the revert record [P1], that's the default. Optional per-site setting **"Aprobar cada publicación"** (off by default) requires the approval link for every publish. |
| **Audit log** | Every tool call that changes state is logged: time, AI app, IP range, files, release id, scan result. Clients see it on the manage page; tool output omits IP data. We keep it 12 months. An email goes out on first connection, on any revert and on any component change. |
| **Revoke** | One tap per connection, plus "revocar todo". A HostBill password change or account suspension revokes all tokens (sync job). The deploy FTP sub-account is suspended on revoke-all and on service suspension [R17]. |
| **Account takeover** | Covered by HostBill's own login, MFA and bans, since we never handle credentials. New-connection email: "¿No fue usted? Revoque aquí." |
| **Reviewer account** | OpenAI review needs a demo login with no MFA [R34]. One dedicated HostBill client, no MFA, exempt from captcha and bans, owning one test site with sample content and release history. Not a real client; monitored; credentials rotated after each review. |
| **Abuse** | Only active, paid hosting services. Phishing/malware hits alert support and freeze publishing on that site. Kill switch per site and globally. The support runbook covers freeze, unfreeze and InterWorx restores. |

---

## 6. Architecture

```
 ChatGPT plugin ─┐                       connect.crservers.com  (one container, k8s)
 Claude connector├─ MCP (streamable HTTP, ┌────────────────────────────────────────────┐
 (Gemini later) ─┘  Bearer token) ───────▶│ MCP adapter ─┐                              │
                                          │ REST + OpenAPI (Level 1 page, mgmt UI)     │
 Phone browser ── upload / manage / ─────▶│ OAuth 2.1 AS (PRM, AS metadata, CIMD, DCR) │
                  preview                 │ Deploy core: changesets · scans · revert   │
                                          │   records · publish · revert · audit ·     │
                                          │   limits · components                      │
                                          └──┬──────────────┬──────────────┬───────────┘
     authorize redirect ▼     code exchange  │              │ FTPS (node   │ Postgres (connections,
  clients.crservers.com ◀────────────────────┘              │ hostname     │ changesets, releases,
  crsconnect plugin: login, MFA, consent,                   │ cert)        │ audit)
  site picker, one-time code [R29]                          ▼              │ S3-compatible bucket
  plugin API fn: redeem code (IP-locked)                    InterWorx node │ (staged files, revert
  site list: getClientAccounts +                            per-site FTP   ▼  records)
  getAccountDetailsBasic                                    user, jailed to
                                                            the web root
                         provisioning job ──▶ SiteWorx API (create/suspend FTP user,
                         (separate, beta+)     write component config) [R17, R21]
```

**Key decisions**
1. **One service, two faces.** The MCP adapter and the REST API share the deploy core. The REST API (with OpenAPI) powers the Level 1 upload page and the management page. No GPT Action, because custom GPTs are being retired [R7].
2. **Auth: HostBill plugin as the sign-in step, connector as the OAuth server.** HostBill can't be an OAuth/OIDC provider for client logins [R22, R23], and its Auto Login and User API don't fit (§5, Login). So:
   - The connector is a thin OAuth 2.1 authorization server that meets the MCP auth essentials: Protected Resource Metadata (RFC 9728), AS metadata (RFC 8414) with `code_challenge_methods_supported`, PKCE S256, the `resource` parameter, **Client ID Metadata Documents and Dynamic Client Registration** (Claude and ChatGPT use them), exact redirect-URI allowlist (Claude and ChatGPT callbacks), short tokens and rotating refresh [R16, R11].
   - Its `/authorize` step creates the signed `req` and redirects to the `crsconnect` plugin on `clients.crservers.com`. The plugin checks login itself (HostBill's `needauth` is undocumented and isn't relied on). If the client isn't logged in, it keeps `req` in its own cookie and sends them to login with a return URL, reusing the client area's existing return-after-login handling for password, MFA and social logins. It then shows consent and the site picker and redirects back with the one-time code.
   - The site picker lists services with `getClientAccounts` (status Active) and `getAccountDetailsBasic`, filtered to the InterWorx module. **Never `getAccountDetails`**: it returns the decrypted account password [R18, R20].
   - The code is redeemed through a plugin API function on HostBill's Admin API, so single use and expiry are enforced by HostBill on its own clock. The `req` HMAC key is the only shared secret; it can't mint codes.
   - Building blocks are confirmed in HostBill's developer samples: client-area controllers know the logged-in client id, consent pages get CSRF tokens, controllers can redirect to outside URLs, and plugins can expose their own API functions [R32]. Full findings and the plugin sketch are in the private `hostbill-crsconnect` repo (spike 0d).
   - **Live tests before building (staging HostBill, in order):** return after password login, MFA and social login; outside redirect; session cookie attributes; service listing and the exact InterWorx module name; whether an API key can be limited to the plugin's function; code single-use/expiry/ownership checks; the real caller IP behind the CDN/WAF; and the sign-in sheet in the ChatGPT and Claude iOS/Android apps (an embedded webview would block Google sign-in).
3. **Writing files on InterWorx.** The SiteWorx API has controllers for backup, FTP, DNS, email, SSL and more, but **no file-manager controller** [R21]. So:
   - At provisioning we create a dedicated **deploy FTP sub-account** with `homedir` set to the site's web root and a random password stored encrypted (`/siteworx/ftp add`; `suspend` and `delete` for revoke) [R17].
   - Reads and writes go over **FTPS to the node hostname**. Our own static-deploy repo found that ProFTPd serves one node certificate, so FTPS to the client's domain can fail TLS [R25].
   - Publish = upload to temporary names → rename into place → delete removed files last. That is fast for small sites but **not atomic** (a seconds-long mixed window). Failures are rolled back with the revert record (§5). Acceptable for v1.
4. **Undo is ours; disaster recovery is InterWorx's [P1].** The connector keeps file-level revert records for the last 5 releases. The InterWorx `/siteworx/backup` API exists [R26], but it can't be limited to web files through the API and a restore overwrites everything it covers [R27], so it's never called by the connector. Nightly/weekly InterWorx backups stay the safety net, restored by support on request.
5. **Provisioning keys stay out of the hot path.** The SiteWorx API with a reseller key + domain can manage any account on the node [R28], which makes it a high-value secret. It's used only by a separate provisioning job (pilot: create the FTP user by hand in SiteWorx, so **no NodeWorx key in the service at all**). Day-to-day publishing uses only per-site FTP credentials.
6. **Where it runs.** The existing Kubernetes cluster, same pattern as crservers.com: a `v*` tag builds an image to GHCR, then the manifests in the repo's `k8s/` folder are applied. 1–2 replicas, managed Postgres, an S3-compatible bucket hosted in Costa Rica, ClamAV sidecar. TypeScript with the official MCP SDK fits the team's Next.js/TS stack. Alerts on publish failures, scan hits and auth errors go to the existing on-call channel, business hours only, because reverts are self-serve.
7. **Managed components are installed by the provisioning job, not the deploy FTP user [P3].** The contact form (`static-site-contact/`) needs:
   - `contact.php` and a **pre-built `vendor/`** in the web root (we never run `composer install` on the client's account, and nothing is built at publish time);
   - its SMTP/Turnstile settings in `~/private/smtp.config.php`, which is **outside the web root**. The jailed deploy FTP user can't write there, by design.

   So `enable_component` queues a job that writes the component files from a pinned release of crservers-static-deploy, and writes the private config with a credential scoped one level above the web root. That's the provisioning job in beta; in the pilot it's done by hand. Component files become read-only paths for the AI (§5). Upgrades re-run the same job.

**Build vs reuse**
| Reuse | Build |
|---|---|
| HostBill accounts, login, 2FA, bans, client area, support tickets | OAuth AS (small, on a maintained library) |
| InterWorx FTP sub-accounts, nightly/weekly backups, quotas | `crsconnect` HostBill client-area plugin: consent + site picker ES/EN, one-time code |
| FTPS lessons from `crservers-static-deploy` [R25] | MCP adapter (official SDK) + tool schemas/annotations |
| Contact form from `crservers-static-deploy/static-site-contact` | Deploy core: change sets, diff, conflict check, FTPS sync, revert records, revert |
| ClamAV, open-source secret-scan rules | Preview server, upload link page, manage page (connections, log, releases, components) |
| crservers.com Next.js site for `/ia` pages and KB; its k8s deploy pattern | Component installer job; ChatGPT plugin package (MCP + skills) and directory submission; Claude setup guide |

**Repositories**
| Repo | Status | Holds |
|---|---|---|
| `edenia/crservers-connector` | new | MCP server, OAuth AS, deploy core, preview/upload/manage pages, component installer job, ChatGPT plugin package, `k8s/` manifests and deploy workflows. This spec lives here as `SPEC.md`. |
| `edenia/hostbill-crsconnect` | new, **private** | The HostBill client-area plugin (PHP, Smarty templates) |
| `edenia/crservers.com` | existing | `/ia` pages, KB prompts ES/EN, `/ia/llms.txt`, tracking issues |
| `edenia/crservers-static-deploy` | existing | Contact form component source (versioned releases the installer pins), FTPS/InterWorx notes |

---

## 7. Product and pricing

**Decided:** free with every shared hosting plan. No add-on and no dedicated plan. Billing for the hosting itself stays in HostBill.

**Positioning (ES PYME):** *"Su sitio web, manejado por su asistente de IA. Seguro, con historial para deshacer cambios y en español."* OpenAI's plugin guidelines don't allow advertising pricing in the listing or selling digital subscriptions inside a plugin [R4]. "Included with your hosting" is the message on crservers.com, not in the listing. The listing and tool outputs don't mention price or "free" and don't link to HostBill order or upgrade pages [R33].

**Pre-made prompts become the setup guide.** We write one KB page per AI (ChatGPT, Claude, "other AI / no connector"), ES (usted) and EN, AI-readable (plain steps, also published as `/ia/llms.txt`):
1. **Connect** (screenshots for the phone).
2. **Starter prompt.** For example: *"Usted es mi webmaster. Use CR Servers para trabajar en [dominio]. Antes de publicar, muéstreme la vista previa y espere mi confirmación. Use solo HTML/CSS/JS estático."*
3. **Task prompts:** create a business site, add a product or property, update prices, add photos, SEO basics (sitemap, titles), turn on the contact form, undo the last change.
4. **No-connector fallback (Level 1):** *"Genere un ZIP listo para subir"*, then the upload page, which also creates a revertible release.

The same prompts ship as **skills inside the ChatGPT plugin** [R1], so users get the guidance without copying anything.

---

## 8. Phased plan

| Phase | Scope | Rough effort | Exit criteria |
|---|---|---|---|
| **0. Spikes** (1 week) | (a) Can each pilot user's ChatGPT plan use write tools on a custom MCP on chatgpt.com, and does the ChatGPT desktop app see custom MCP servers or only the web? (b) ✅ Done: ChatGPT directory requirements (public only, CR country limit, origin lock, no-MFA reviewer account, 1–3 week review); business verification already approved. Still to test: a write action from an existing directory plugin on the iPhone/Pro user's phone. (c) FTPS sub-account jailed to web root on a live node, including MLSD listing and rename. (d) ✅ Desk research done: go with caveats. Live tests on staging HostBill remain (§6, decision 2). (e) Revert records: publish and revert a real change on a test site, and simulate a failure halfway through phase 2. | ~1 dev-week | Go/no-go per path, written up in the tracking issue |
| **1. Pilot** (two users, both on ChatGPT) | **Track A, desktop user:** ChatGPT custom MCP on chatgpt.com, starts as soon as the build works (no OpenAI review). **Track B, iPhone user (ChatGPT Pro, iOS app):** needs the published plugin. Custom MCP is web-only, and on Pro it's documented as read/fetch only [R5], so chatgpt.com on a computer isn't a write fallback either. Until approval: the Level 1 path (ChatGPT writes the change, the user uploads it through the phone upload page) or the Claude iOS app. Both tracks: MCP server, minimal AS, `crsconnect` plugin (minimal), **manual** FTP-user provisioning, change sets, conflict check, preview, publish, revert records, revert, upload link, basic activity log, allowlist + ClamAV, Spanish consent. Static only (the pilot site has no PHP). **The ChatGPT directory submission is on the critical path for track B.** Submit once publish/revert are production quality (no demo build), with: final MCP URL `https://connect.crservers.com/mcp`, domain verification route, privacy policy, terms, support and `/ia` pages naming Sistemas Edenia Internacional S.A., the reviewer account, 5 positive and 3 negative test cases, a video walkthrough on web, desktop and iOS, logo, and `countries: ["CR"]`. | ~3–4 dev-weeks | Per track: ≥5 real publishes in 2 weeks with no copy-paste, 1 successful revert, 0 support tickets, written client feedback |
| **2. Beta** (10–30 clients) | Self-serve provisioning through the SiteWorx API, "Conectar IA" in the HostBill client area, manage/revoke page, Level 1 upload page on the same core, **contact form as the first managed component**, rate limits, secret/JS/phishing scans, alerts, support runbook for the HostBill ticket team, KB prompts ES/EN, **ChatGPT plugin listed publicly** (if approved). | ~4–6 dev-weeks (+ OpenAI review time) | ≥70% of beta sites publish weekly; tickets ≤1 per 10 sites per month; no security incident |
| **3. GA** | All shared nodes, abuse monitoring, runbooks, blog + case study, `/ia` landing page. Decide on raw PHP opt-in, WordPress and Gemini. | ~3–4 dev-weeks | Available on every shared plan; support load stays flat |

**Riskiest assumptions** (cheapest test first)
1. Phone users can reach a write-capable connector. ChatGPT custom MCP is web-only with write support uncertain on personal plans [R5, R6], the mobile path needs a published plugin [R2, R4], and Gemini is US-only [R12]. Both pilot users are on ChatGPT, one of them on the iPhone app, so this is the top risk. → Spike 0a/0b, submit early, desktop track first, Level 1 fallback.
2. The HostBill plugin can carry the sign-in cleanly: return after login/MFA/social login, the CDN/WAF in front of the client area, and the AI apps' sign-in sheets on phones. → Spike 0d live tests.
3. FTPS sub-accounts are a reliable write path on every node (TLS quirks [R25], non-atomic publish). → Spike 0c on two nodes, spike 0e for failure recovery.
4. Non-technical users accept the preview → confirm loop on a phone. → Pilot feedback.
5. Free access doesn't drive support load beyond what the ticket team can absorb. → Beta ticket metrics.

---

## 9. Open questions for Xavier

**Settled 2026-10-07:** Q2 login (HostBill plugin), Q3 PHP (static by default; see [P2]), Q4 pricing (free), Q6 retention (no snapshots; see [P1]), Q7 hosting and identity, Q8 public listing from beta, Q9 support (HostBill ticket team).

**Settled 2026-10-10:** [P1] revert records, last 5 releases per site · [P2] static + managed components, no raw PHP from the AI in v1 · [P3] components installed by a separate provisioning job (by hand in the pilot) · [P4] refuse publish on conflict, one publish/revert at a time per site.

**Still open**
1. **Pilot plans (Q1, partly settled):** both pilot users are on ChatGPT: the iPhone user on **ChatGPT Pro** (iOS app), the other on ChatGPT desktop. Still needed: **the desktop user's plan**. Write tools on custom MCP are only documented for Business/Enterprise/Edu [R5]; spike 0a checks whether that's still true for Pro and Plus.
2. **Pilot user B write test:** on the iPhone (ChatGPT Pro), run a write action from any existing directory plugin. Confirms a published plugin can write on Pro in the iOS app.

**Closed:** Q5 (decided 2026-10-10, §5 Confirmation). Q10.**Closed:** Q10. The pilot site already has a valid Let's Encrypt certificate (checked 2026-10-10). The 2026-10-07 "self-signed" finding came from a check without SNI, which gets another site's certificate on a shared IP. The connector doesn't depend on the site certificate anyway: it uses FTPS to the node hostname.

---

## References
- [R1] OpenAI, Plugins docs index (plugins = MCP servers + skills + UI): https://developers.openai.com/plugins/llms.txt
- [R2] OpenAI Help Center, "Plugins in ChatGPT" (directory across plans; use on web, desktop, mobile): https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex
- [R3] OpenAI, "Connect and test your plugin" (Add custom MCP server at chatgpt.com/plugins): https://developers.openai.com/plugins/deploy/connect-chatgpt
- [R4] OpenAI, combined Plugins docs (file params, tool annotations incl. `openWorldHint` for publishing, plugin guidelines: desktop + mobile, no pricing or digital sales, prompt-injection guidance): https://developers.openai.com/plugins/llms-full.txt · submission: https://developers.openai.com/plugins/deploy/submission
- [R5] OpenAI Help Center, "Developer mode and MCP apps in ChatGPT" (full MCP/write beta for Business/Enterprise/Edu; Pro read/fetch; MCP apps web-only; refresh tokens/`offline_access`): https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- [R6] OpenAI Developer Community, staff note on removing the explicit developer mode toggle: https://community.openai.com/t/developer-mode-missing-and-mcp-app-creation-unavailable-across-multiple-chatgpt-accounts/1402294/3
- [R7] OpenAI Help Center, "Creating and editing GPTs" / "Configuring actions in GPTs" (GPT retirement, no new GPTs on personal plans): https://help.openai.com/en/articles/8554397-creating-and-editing-gpts · https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts · auth: https://developers.openai.com/api/docs/actions/authentication
- [R8] OpenAI Community bug reports on GPT Actions on mobile: https://community.openai.com/t/custom-gpt-actions-with-authentication-type-oauth-does-not-work-on-android-devices/1350646 · https://community.openai.com/t/custom-gpt-action-no-longer-invoked-on-mobile-clients-since-chatgpt-app-1-2026-139-regression/1382131/1
- [R9] Claude Help Center, custom connectors with remote MCP (plans, Free = 1): https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- [R10] Claude Help Center, use connectors (mobile apps; adding on mobile in beta): https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities
- [R11] Claude docs, connector authentication (DCR, CIMD, callback URL): https://claude.com/docs/connectors/building/authentication · https://claude.com/docs/connectors/custom/add-unlisted
- [R12] Google, Gemini custom apps (MCP) requirements: https://support.google.com/gemini/answer/17209137
- [R13] Google blog, Gemini Spark custom MCP (June 2026): https://blog.google/innovation-and-ai/products/gemini-app/gemini-spark-updates-june-2026/
- [R14] Google, Gemini Spark availability: https://support.google.com/gemini/answer/17094507
- [R15] MCP spec, Tools (annotations): https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- [R16] MCP spec, Authorization (OAuth 2.1, RFC 9728/8414/8707, CIMD, DCR, PKCE, no token passthrough): https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- [R17] InterWorx API, `/siteworx/ftp` (add with homedir, suspend, delete): https://appendix.interworx.com/current/api/siteworx/ftp.html
- [R18] HostBill Admin API, `getClientAccounts`: https://api2.hostbillapp.com/clients/getClientAccounts.html
- [R19] HostBill Admin API, `verifyClientLogin` (considered in v0.1, not used): https://api2.hostbillapp.com/clients/verifyClientLogin.html
- [R20] HostBill Admin API, `getAccountDetailsBasic` (use) and `getAccountDetails` (avoid: returns the decrypted password): https://api2.hostbillapp.com/accounts/getAccountDetailsBasic.html · https://api2.hostbillapp.com/accounts/getAccountDetails.html · InterWorx module: https://hostbill.atlassian.net/wiki/spaces/DOCS/pages/1213321/InterWorx
- [R21] InterWorx, SiteWorx API controller index (no file manager controller): https://appendix.interworx.com/current/api/siteworx/siteindex.html
- [R22] HostBill, Admin OIDC Authentication (HostBill as OIDC *client* for staff): https://hostbill.atlassian.net/wiki/spaces/DOCS/pages/4240048129/Admin+OIDC+Authentication
- [R23] HostBill, Log-in with Google (client SSO as consumer): https://hostbill.atlassian.net/wiki/spaces/DOCS/pages/38961172/Log-in+with+Google
- [R24] HostBill, User API module (JWT, refresh tokens, MFA verification methods, service listing): https://hostbillapp.com/products-services/user-api/
- [R25] edenia/crservers-static-deploy README (FTPS to node hostname, InterWorx paths): https://github.com/edenia/crservers-static-deploy
- [R26] InterWorx API, `/siteworx/backup` (create/list/restore): https://appendix.interworx.com/current/api/siteworx/backup.html
- [R27] InterWorx, Backup and restore from SiteWorx (partial = website/email/database): https://appendix.interworx.com/current/siteworx/domains_and_websites/backup_restore/backup-siteworx-account.html
- [R28] InterWorx API overview (auth: NodeWorx user, reseller API key, session; SiteWorx calls need a domain): https://appendix.interworx.com/current/api/index.html
- [R29] HostBill Admin API, remote API keys locked to IP/CIDR and specific functions: https://api2.hostbillapp.com/remote.html · hooks: https://hooks.hostbillapp.com/
- [R30] HostBill, Client Auto Login (shared secret + email; rejected): https://hostbill.atlassian.net/wiki/display/DOCS/Auto+Login
- [R31] HostBill, User API (Basic/JWT from password; no scopes; rejected for sign-in): https://hostbill.atlassian.net/wiki/display/DOCS/User%20API
- [R32] HostBill developer docs and samples (plugin modules, controllers, module API functions): https://dev.hostbillapp.com/ · third-party write-up: https://whmcstools.com/hostbill-plugin-development/
- [R33] OpenAI, Upload and submit your plugin; plugin guidelines (public release, `countries`, origin lock, annotations, no secrets in inputs, no pricing): https://developers.openai.com/plugins/deploy/submission.md · https://developers.openai.com/plugins/plugin-guidelines.md
- [R34] OpenAI, Remote MCP server review requirements (submit only if public; private use via custom MCP; demo account without MFA): https://developers.openai.com/plugins/deploy/app-review.md · review-time thread: https://community.openai.com/t/how-long-does-the-plugin-review-and-approval-process-usually-take/1388430
- [R35] OpenAI, plugin authentication (RFC 9207 `iss`, redirect URIs, CIMD/DCR): https://developers.openai.com/plugins/build/auth.md
- [R36] OpenAI Help Center, Managing app permissions in ChatGPT ("always allow"): https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt
- `static-site-contact/contact.php` reads `~/private/smtp.config.php` outside the web root and needs `vendor/` (Composer): https://github.com/edenia/crservers-static-deploy/tree/main/static-site-contact
