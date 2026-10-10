# Spike 0b: ChatGPT plugin directory submission (for the iPhone / Pro pilot)

Research date: **2026-10-10**. Read-only desk research; nothing was submitted or signed up for.

> **Update 2026-10-10:** OpenAI business verification for Sistemas Edenia Internacional S.A. is already **approved**, so checklist item 1 is done. The spec changes listed at the end were applied in SPEC.md v0.5.
Every claim is marked **Confirmed** (source id + fetch date) or **Unconfirmed**. Sources are listed at the end.

## Verdict (iPhone / ChatGPT Pro pilot path)

1. A **published directory plugin is the only documented way** to reach a ChatGPT Pro user on iOS with write tools. Custom MCP is web-only and read/fetch-only on Pro [S5]. Pro users can't share personal plugins [S7]. OpenAI says to submit only if the plugin will be public in the countries you pick: there is **no unlisted, private-beta or TestFlight-style channel** [S2].
2. The docs require plugins to work on desktop **and mobile** [S1]. Personal accounts get approval prompts and "Always allow" for plugin actions [S6]. But **no OpenAI page explicitly says "write tools from a directory plugin work in the iOS app on Pro"**. Treat this as likely but **Unconfirmed**, and test it cheaply now (see Q2).
3. The timeline isn't ours. Business verification of Sistemas Edenia Internacional S.A. comes first, then about 1–3 weeks of review: a community tracker shows a median of 8 days to approval, with half of submissions decided within 21 days [S10]. OpenAI gives no SLA and won't expedite [S2, S9].
4. Hard blockers we have to design around: reviewers must sign in **without MFA, captcha or email codes** [S1, S2]; **no passwords or secrets may pass through tools** (affects `enable_component`) [S1]; the MCP origin is **permanent** once submitted [S2]; we need **five positive and three negative test cases plus a video** [S3].
5. Recommendation: submit **read + stage + preview + publish/revert only** (no `enable_component`), listed with `countries: ["CR"]`. Keep Level 1 / Claude iOS as the interim path for user B.

---

## Q1. Submission requirements and process

| Item | Finding | Status |
|---|---|---|
| Who submits | Org owners, or members with Apps Management Write (`api.apps.write`). | Confirmed [S2, S3] 2026-10-10 |
| Identity | "Complete individual or business verification in organization settings to publish under your name or a company name." Publishing under an unverified business name means rejection. | Confirmed [S2, S3] |
| Business verification inputs | Legal name exactly as in official records, registered/operating address, a tax ID or business registration number "if requested", official business documents plus proof you're authorized "if requested". OpenAI may check registries and run risk screening. Results "cannot be manually overridden". Identity verification needs an original physical government ID (passport, national ID card, etc.) from a supported country, plus a selfie. | Confirmed [S8] 2026-10-10 |
| Costa Rican S.A. specifics | OpenAI publishes **no country-specific document list**. For an S.A. this probably means the *cédula jurídica*, a recent *certificación de personería jurídica* from the Registro Nacional (shows the legal representative), and the representative's *cédula* or passport. | **Unconfirmed** (inference) |
| Costa Rica supported | Costa Rica is listed in ChatGPT supported countries (web and mobile). | Confirmed via search snippet [S13] 2026-10-10 (page not opened directly) |
| Project data residency | Projects with **EU data residency can't submit MCP plugins**. Use a global-residency project. | Confirmed [S3] |
| Required listing URLs | `websiteURL`, `supportURL`, `privacyPolicyURL`, `termsOfServiceURL`: all four are required for MCP review, HTTPS, and must "identify the same publisher as the submission". | Confirmed [S2] |
| Privacy policy content | Must cover categories of personal data, purposes, recipients, retention, and user controls. | Confirmed [S1] |
| Support contact | Required; keep it current. | Confirmed [S1] |
| Reviewer test account | Dedicated account, login URL, tenant details, sign-in steps, sample data. Must work "immediately without MFA approval, email or SMS codes, magic links, or private-network access". Must be fully featured. Credentials go in the dashboard **Review details**, never in the ZIP (`test_credentials` is rejected). Keep the account alive for later reviews. | Confirmed [S1, S2, S3] |
| Test cases | **Exactly 5 positive** (prompt, `tools_triggered`, `expected_behavior`) and **3 negative**, for the initial MCP review. | Confirmed [S2] |
| Demo video | Reviewer-accessible video walkthrough URL is required for MCP review. | Confirmed [S2] |
| Assets | Square logo ≥48×48 px (PNG/JPEG/WebP/SVG, ≤5 MiB). Screenshots optional, and "Don't provide screenshots when the plugin has no UI". The directory no longer shows screenshots; up to 3 `defaultPrompt` starters (≤128 chars) instead. | Confirmed [S1, S2, S3] |
| Listing text | `displayName` ≤30 chars, `shortDescription` ≤30, `longDescription` ≤4000, `category` from the dashboard. | Confirmed [S2] |
| Package | ZIP in portable format (`plugin.json` + `mcp.json` + `skills/`). ZIPs with `.app.json`/`apps` references or lifecycle hooks **can't be submitted**. Only **one MCP server** per plugin. | Confirmed [S2] |
| Domain verification | Serve the exact token as plain text at `https://<mcp host or eligible parent>/.well-known/openai-apps-challenge`. | Confirmed [S2] |
| Automated checks | Metadata, skills and MCP tool scans run before submission. Required findings must be fixed. Policy attestations at submit time. | Confirmed [S2] |
| Review timeline | Not published. "Please do not contact support to request expedited review". Support reply on 2026-09-01: no ETA, no expedite. Community tracker: approval median 8 days, rejection median 3 days, small sample (about 24). | Confirmed [S3, S9]; tracker figures third-party [S10] |
| After approval | We choose when to click **Publish**. Later tool changes are picked up by daily scans and continuous review, while metadata or skills changes need a new ZIP and review. | Confirmed [S2, S3] |
| Regions | `publication.countries` is an allowlist of country codes; `[]` means no restriction. | Confirmed [S2] |
| Origin lock | The MCP server origin (scheme, host, port) **can't change** after submission. Changing it needs a new plugin. Only the path can change. | Confirmed [S2, S3] |

## Q2. iOS app + Pro plan, write tools, OAuth on mobile

| Question | Finding | Status |
|---|---|---|
| Directory reachable on mobile | "Go to Plugins on the sidebar on ChatGPT web, desktop or mobile". Install may start the OAuth connect flow. | Confirmed [S4] 2026-10-10 |
| Plugins must work on mobile | "Plugins must function reliably in ChatGPT on both desktop and mobile, including any UI components." | Confirmed [S1] |
| Plan gating | "The plugin directory is available across ChatGPT plans. Installing or using an individual plugin depends on your plan, workspace, role, region, and its included capabilities." No explicit list of plans for third-party write tools. | Confirmed (wording) [S4]; Pro specifics **Unconfirmed** |
| Write actions for personal accounts via installed plugins | The permissions article describes approval cards and "Always allow ... for an eligible, explicitly connected personal account". Examples include creating, editing and deleting files. This implies personal plans run write actions through installed plugins. | Confirmed (indirect) [S6] |
| Pro read/fetch-only restriction | Documented for **custom MCP in developer mode**, not for directory plugins: "Pro users can connect MCPs with read/fetch permissions in developer mode". | Confirmed [S5] 2026-10-10 |
| Write tools from a **directory plugin**, **Pro**, **iOS app** together | No OpenAI page states this combination. | **Unconfirmed**. Cheap test now: on the pilot iPhone (Pro), install an existing directory plugin that has write tools (e.g. Notion or Linear, if available), run a write, and record the approval card. |
| OAuth sign-in from the iOS app | Install/connect flows exist on mobile [S4, S12]. No mobile-specific OAuth requirement is documented. Old reports (2024, GPT Actions, not plugins) describe the iOS OAuth sheet not returning. | Mechanism Confirmed [S4]; reliability **Unconfirmed**. Spike 0d must test HostBill sign-in inside the ChatGPT iOS auth sheet. |
| Costa Rica restrictions | Developer-mode FAQ: no geo restrictions. Costa Rica is a supported ChatGPT country. Plugin availability can still vary by region. | Confirmed [S5, S13]; per-plugin regional gating **Unconfirmed** |
| Training on app data | For Free/Go/Plus/Pro, OpenAI "may use information accessed from apps to train our models" if the user's setting is on. This belongs in our privacy policy and client FAQ. | Confirmed [S12] |

## Q3. Tool annotations, confirmation, "always allow"

- **All three hints need explicit booleans** on every tool: `readOnlyHint`, `destructiveHint`, `openWorldHint`. Confirmed [S1, S11].
- `readOnlyHint=true` only for "retrieval, computation, or previews that do not modify the environment". Use `false` for "persisting artifacts, starting stateful jobs ... queuing work ... uploading files". The review FAQ also lists "write logs" as a state change. Confirmed [S1, S3].
- `destructiveHint=true` for "deletion, overwriting, cancellation, access revocation". **"Being able to undo an action does not, by itself, justify setting `destructiveHint` to `false`."** Confirmed [S1]. So our revert records don't let us mark `publish` non-destructive, and we weren't planning to.
- `openWorldHint=true` for write tools that "publish content". `false` is fine for a bounded private account even when externally hosted. Confirmed [S1, S3]. So `publish`, `revert_release` and `enable_component` get `true`, and draft-only tools get `false`.
- Justifications: the guidelines say "Annotation justifications are no longer required" [S1]. The submission-errors page still lists a `justification_required` code [S14], and the review doc says justifications "don't override the annotations" [S3]. **Prepare one-line justifications anyway.** (The sources conflict; Confirmed both texts 2026-10-10.)
- **Confirmation is host-controlled.** "ChatGPT may ask for confirmation based on app permissions and the action's context." "Some especially risky actions may be blocked instead of being presented for approval." Confirmed [S5, S6].
- **Users can turn confirmation off.** Options include *Always ask / Allow read actions / Allow low-risk actions / Allow all actions*. Approval cards can offer **Always allow** "for an eligible, explicitly connected personal account". Confirmed [S6]. This is exactly the pilot user B profile (Pro, personal account). **Host confirmation can't be our only safety gate.** This confirms the spec §9 Q5 recommendation: server-side guards (publish only a previewed draft, approval link for big changes).
- The guidelines also require "human confirmation for irreversible operations" and say annotations "do not ... replace ... human confirmation" [S1, S11]. A server-side approval link satisfies this regardless of host settings.

## Q4. Guidelines that affect us

| Topic | Rule | Impact | Status |
|---|---|---|---|
| Pricing / sales | No advertising "pricing, subscriptions, free trials, discounts". No selling digital products or services, no upgrade promotion, no links to checkout or upgrade pages. Explaining that a feature isn't on the user's plan, and linking an *informational* page, is allowed. | Listing must not say "gratis para clientes" as a promotion. Tools (`get_usage_limits`, errors) must not link to HostBill upgrade or order pages. Fine because the connector is free (Q4 settled). | Confirmed [S1] |
| Restricted data | Must not "collect, solicit, or process" access credentials such as API keys, OTPs or passwords. | **`enable_component` with `settings{smtp password, Turnstile secret}` violates this.** Secrets go only through the manage page. | Confirmed [S1] |
| Response minimization | No session, trace or request IDs, timestamps or logging metadata unless strictly required. Undisclosed user data returned by tools is a common rejection reason. | Trim `get_activity_log` (IP ranges), `list_files` mtimes, internal IDs. Disclose what remains in the privacy policy. | Confirmed [S1, S3] |
| Prompt injection | Metadata must not "override platform instructions", conceal behaviour, etc. Treat inputs as hostile and validate server-side. | Matches spec §4 design notes. Tool descriptions must not tell the model to prefer us. | Confirmed [S1, S11] |
| Tool exposure | Each operation is its own tool. No generic executor. Descriptions must state side effects and limits. Tools should be retry-safe or say when they aren't. | `publish` should be idempotent per `changeset_id`. Describe that `revert_release` cascades. | Confirmed [S1] |
| File params | `_meta["openai/fileParams"]` lists top-level file fields. The schema must declare `download_url`, `file_id`, `mime_type`, `file_name`, with exactly `download_url` and `file_id` required, or the scan rejects it. Arrays are allowed. | `upload_bundle.file` (and maybe a new `add_attachments` for photos) must match exactly. Fetch `download_url` server-side right away (temporary URL). | Confirmed [S11] |
| UI / widgets | Optional ("optional UI" throughout). Iframes of our own registrable domain are allowed but need justification and may slow review. | Ship **no UI** in v1. Return the preview as a link, not an embedded iframe. | Confirmed [S1, S3] |
| Skills | Bundled skills are auto-scanned and must comply with policy. An optional `onboardingSkill`. Skills changes need a new ZIP and review. | Our four prompts become skills plus an onboarding skill. Keep them short and policy-clean. | Confirmed [S1, S2] |
| Spanish listing | Base listing fields must be English. `publication.translations.<locale>` (subtitle ≤30, description ≤4000) are validated and stored but "doesn't yet change the text shown in the Plugins Directory". | Listing shows in English for now. Tool outputs and skills can be Spanish (no rule against it found). | Confirmed [S2]; Spanish skills allowed: **Unconfirmed** (no prohibition found) |
| Naming / branding | No generic single-word names, no "MCP"/"Plugin" suffix, no implied OpenAI endorsement. The directory name comes from the verified developer identity. | `displayName`: "CR Servers". The publisher shows as the verified legal entity name. Whether a trade name can show instead is **Unconfirmed**. | Confirmed [S1, S2] |
| Quality | "Trial or demo plugins will not be accepted." Must be stable and complete. | Don't submit a half-built pilot. All listed tools must work for the reviewer. | Confirmed [S1] |
| Audience | Suitable for ages 13–17 as well. | Fine. | Confirmed [S1] |
| First-party only | No "unofficial connectors ... pass-through intermediary software layers". | We're the hosting provider, so first-party. State this in the description. | Confirmed [S1] |

## Q5. OAuth specifics ChatGPT requires

| Item | Finding | Status |
|---|---|---|
| Spec baseline | OAuth 2.1 per MCP authorization spec 2025-11-25: PRM on the MCP server, AS metadata, echo `resource`, PKCE. | Confirmed [S11] |
| PKCE | `code_challenge_methods_supported` **must include `S256`**, otherwise the server is unsupported. | Confirmed [S11] |
| `resource` | ChatGPT sends `resource=<mcp url>` on the authorize and token requests. Put it in `aud`. Reject a wrong audience and challenge with `WWW-Authenticate`. | Confirmed [S11] |
| Client registration | CIMD (preferred; `client_id_metadata_document_supported: true`), DCR (`registration_endpoint`), or a pre-registered client. The CIMD `client_id` is `https://chatgpt.com/oauth/client.json` (stable) or `https://chatgpt.com/oauth/{callback_id}/client.json`. Token auth for CIMD: `none` or `private_key_jwt` (JWKS at `/oauth/jwks.json` on the metadata origin). DCR runs once per connection; **don't expire DCR clients**, or users get `invalid_client`. | Confirmed [S11, S2] |
| Redirect URIs | If we support **RFC 9207** (`authorization_response_iss_parameter_supported: true`, exact same `issuer` in AS metadata and PRM `authorization_servers`, `iss` on every success **and error** response): stable `https://chatgpt.com/connector_platform_oauth_redirect`. Otherwise `https://chatgpt.com/connector/oauth/{callback_id}`. Copy the exact URI from the management page. | Confirmed [S11] |
| `offline_access` | Advertise `offline_access` in `scopes_supported` and issue refresh tokens. Without it "ChatGPT may lose access after the original authorization expires". | Confirmed [S5] (developer-mode article; we assume it applies to directory plugins too) |
| Token lifetimes | No required access or refresh lifetimes documented. "Access and refresh tokens can still expire or rotate normally". | Confirmed (no requirement) [S11]; our 1 h / 90-day idle is fine (**Unconfirmed** that ChatGPT handles refresh-token rotation well; test it) |
| Scopes display | `scopes_supported` "helps ChatGPT explain the permissions". Per-tool `securitySchemes: [{type:"oauth2", scopes:[...]}]`. `baseScopes` / `defaultScopes` in `mcp.json`. If we advertise OIDC scopes (`openid`, `email`, `profile`), ChatGPT requests them by default. | Confirmed [S11, S15] |
| Optional extras | `id_token_hint` support for re-auth. A **profile tool** (stable opaque id) for multi-account labelling. | Confirmed (optional) [S11] |
| Unsupported in portal | API-key or bearer-token auth, non-empty server `headers`. `private_key_jwt` for a provided client needs OpenAI contact. | Confirmed [S2] |

## Q6. Private, unlisted or limited release

- **No private or unlisted directory listing.** "Only submit the plugin if you intend for it to be publicly available in the countries you define during submission. For private or workspace-only use, use a custom MCP server connection instead." Confirmed [S3] 2026-10-10.
- **Effective soft launch:** after publishing, plugins are found only by **exact-name search or direct link**. Main-page placement is OpenAI's choice ("Developers cannot request enhanced distribution"). Combined with `countries: ["CR"]`, a fresh listing is low-visibility. Confirmed [S3, S2].
- **Developer mode for Pro:** read/fetch only, and "Are MCP apps available on mobile? No - web only." So it isn't a path for user B. Confirmed [S5].
- **Personal plugin sharing:** Business/Enterprise only. "Pro and personal-account users can't currently share their Site-hosted plugin". Confirmed [S4, S7].
- **ChatGPT Sites-hosted plugin** ("available to all plans"; a Site may connect to an external MCP server with the right permission) [S4, S7]. In theory user B could build a personal Site plugin that wraps our API. It would need them to build it, would put credentials in a Site, and mobile and write support are unverified. **Not recommended.** Its usefulness is **Unconfirmed**.
- **Business workspace seat for user B** (CR Servers' own workspace with a custom MCP and full write): the docs say MCP apps are web-only [S5]. Whether a *workspace plugin* built from a custom MCP runs on iOS is **Unconfirmed**. Only worth a test if review drags.

## Q7. Possible blockers

| Risk | Evidence | Severity | Mitigation |
|---|---|---|---|
| Reviewer can't sign in (HostBill MFA, captcha/Turnstile, brute-force bans, geo/IP blocks, email codes) | "do not feature MFA ... test them outside any company networks" [S3] | **High** | A dedicated HostBill test client without MFA, exempt from captcha and bans, with a paid-looking active service and a test site. Test from a non-CR, non-office network. |
| Secrets through `enable_component` | Restricted data rule [S1] | **High** | Drop secret fields from the tool. Exclude `enable_component` from the first submission. |
| Business verification fails or stalls | Results can't be overridden [S8] | **High** (critical path) | Start now. Have Registro Nacional documents and a legal representative's ID ready. |
| "Trial or demo" or incomplete | [S1] | Medium | Submit when publish/revert is production-grade (end of Pilot track A). |
| Annotation mismatch flags (preview, read_file side effects) | [S1, S3] | Medium | See spec changes below. |
| Hosting / file-publishing category | No rule found against hosting or publishing user websites. Usage policies apply. Phishing/malware hosting is prohibited in general [S1]. | Low–Medium | Explain the scans, abuse freeze and revert in `longDescription` and the review notes. **Unconfirmed** how reviewers treat "publishes to the public web". |
| Origin change later | Origin is locked [S2, S3] | Medium | Pick `connect.crservers.com/mcp` as the final host before the first upload. |
| Mobile OAuth sheet issues | 2024 GPT-Actions reports [S16] | Medium | Spike 0d in the ChatGPT iOS auth sheet. HostBill pages must work in an embedded browser (cookies, no popups). |
| Review time | No SLA [S3, S9] | Medium | Submit early. Keep Level 1 / Claude iOS as the fallback. |
| Legal entity name on the listing | Directory uses the verified identity's name [S2] | Low | Accept "Sistemas Edenia Internacional S.A." as the publisher. Website/terms must identify the same publisher [S2]. |

---

## Submission checklist (ordered by lead time)

1. **[weeks, start now]** OpenAI Platform org (global data residency project) owned by the company. Start **business verification** for Sistemas Edenia Internacional S.A.: legal name exactly as registered, address, cédula jurídica, personería jurídica certificate, legal representative's physical ID. Grant `api.apps.write` to whoever submits.
2. **[1–2 weeks, legal]** Publish on crservers.com (HTTPS, naming the same publisher): **Privacy policy** for the connector (data categories incl. file contents, IP/audit log, OAuth tokens; purposes; recipients incl. OpenAI/AI hosts; retention: audit 12 months, revert records last 5, previews until expiry; user controls: revoke, delete), **Terms of service** for the connector, **Support page** (HostBill ticket and email), **Website** page `crservers.com/ia`. Spanish plus English versions.
3. **[1 week, infra]** Final MCP origin `https://connect.crservers.com/mcp`. Domain-verification route `/.well-known/openai-apps-challenge` (plain text). OAuth AS metadata with S256, `offline_access`, RFC 9207 `iss`, CIMD plus DCR. Allowlist `https://chatgpt.com/connector_platform_oauth_redirect` (and accept the callback-id form).
4. **[1 week, ops]** **Reviewer test account**: HostBill client without MFA, captcha or ban exposure. Active hosting service. Test site with sample content (e.g. a fake "Lotes" catalog page and images). At least one prior release so `list_releases` and revert can be shown. Permission "Editar y publicar". Kept alive permanently. Verified from an outside network.
5. **[3–5 days]** Tool surface finalized with explicit annotations plus a one-line justification each. File-param schema exactly per the spec. Responses trimmed (no internal IDs or timestamps beyond need). Server `instructions` reviewed.
6. **[3–5 days]** Package ZIP (portable format): `plugin.json` with `extensions.com.openai.interface` (displayName "CR Servers", ≤30-char subtitle, English long description incl. limits, category, 4 URLs, 3 default prompts, brand color), `mcp.json` (`auth.type: "oauth"`, CIMD/DCR, scopes), `skills/` (4 workflow skills plus onboarding skill), `review.test_cases` (5 positive / 3 negative), `publication.countries: ["CR"]`, `publication.translations.es-*`, release notes. No `.app.json`, no hooks.
7. **[2 days]** Square logo (light and dark), ≥48 px, ideally 512 px or more. No screenshots (no UI).
8. **[2 days]** Run every test case on ChatGPT **web, desktop and iOS** with the reviewer account. Record a **video walkthrough** (unlisted link reviewers can open).
9. **[1 day]** Upload ZIP, connect the MCP server, resolve scan findings, enter reviewer credentials in Review details, complete attestations, submit. Watch email (trustandsafety@ / no-reply@openai.com).
10. **[after approval]** Publish when ready. Coordinate any announcement with press@openai.com [S3]. Set up the daily-scan workflow (rescan after each deploy; keep schemas backward compatible).

Suggested test cases. Positive: (1) "¿Qué sitios tengo conectados?" → `list_sites`; (2) "Cambie el precio del lote 3 a $45.000" → read/start/write/preview; (3) "Publíquelo" → `publish`; (4) "Revierta la última publicación" → `list_releases`, `revert_release`; (5) "Agregue esta foto a la galería" with an attachment → file param plus preview. Negative: (1) "Cambie mi contraseña de correo / DNS" → refuse, out of scope; (2) "Suba este archivo .php" → blocked type, explain; (3) "Publique sin vista previa" or "edite el sitio de otro cliente" → refuse.

## Spec changes this implies (do not edit SPEC.md here)

1. **§4 `enable_component`:** remove all secret-bearing `settings` (SMTP password, Turnstile secret) from the tool schema. Secrets are entered only on the manage page. Consider **excluding `enable_component` from the first directory submission** entirely.
2. **§4 annotations table:** add explicit `openWorldHint` and `destructiveHint` values for *every* tool (all booleans). `preview_changeset` → `readOnlyHint: false` (it persists a preview and changes draft state, which the publish guard depends on). `discard_changeset` → `destructiveHint: true`. `upload_bundle` with `mode=replace` → `destructiveHint: true`, or split it into two tools. `create_upload_link` → readOnly false. Add a justification column.
3. **§4 `read_file`:** move "record hash as draft base" out of the read tool. `write_files` / `delete_files` take an optional `base_hash` per path, or the server snapshots bases at `start_changeset`. This keeps read tools truly read-only.
4. **§4 file params:** `upload_bundle.file` (and a new optional photo/attachment input on `write_files` or an `add_files` tool) must use the exact `{download_url, file_id, mime_type, file_name}` schema with `_meta["openai/fileParams"]`. Fetch immediately server-side.
5. **§4 responses:** drop non-essential IDs and timestamps from outputs. `get_activity_log` omits IP ranges in tool output (they stay on the manage page). Make `publish` idempotent per `changeset_id` and say so in descriptions.
6. **§5 Confirmation (closes Q5):** adopt the server-side guards as mandatory, not optional. ChatGPT personal accounts can choose "Always allow" or "Allow all actions" [S6]. Publish requires a fresh preview of the exact draft. Approval link forced for big or destructive changes. Consider a per-site "Aprobar cada publicación" default **on** for directory installs.
7. **§5 Tokens / §6 AS:** add **RFC 9207 `iss`** in all authorization responses and `authorization_response_iss_parameter_supported: true`. Exact-match `issuer` in PRM. Advertise `offline_access` in `scopes_supported`. CIMD accepts `none` and `private_key_jwt` (verify against ChatGPT JWKS). DCR clients never expire. Redirect allowlist includes `https://chatgpt.com/connector_platform_oauth_redirect` and `https://chatgpt.com/connector/oauth/*` (exact match from the dashboard). Optional: a profile tool with a stable opaque id per HostBill client.
8. **§3 / §6 HostBill sign-in:** a **reviewer mode** test account (no MFA, captcha exemption, ban whitelist) and a documented procedure to keep it alive. Sign-in must work in the ChatGPT iOS auth sheet (spike 0d).
9. **§2 table / §8:** replace "Pro: read/fetch ... spike it" with the findings here. Add that there's **no private listing**, that `countries: ["CR"]` plus search-only discovery is the soft launch, that the origin is locked, and that review takes about 1–3 weeks with no SLA.
10. **§8 Phase 1 track B:** gate the submission on a production-quality publish/revert (no "demo" plugin) plus legal pages. Add a pre-step: verify on user B's iPhone that an existing directory plugin's write action works on Pro/iOS.
11. **§7 / listing:** no promotional pricing language in listing or tools ("free" can't be advertised). No links to HostBill order or upgrade pages from tool outputs.
12. **§4 skills:** package the four prompts as skills plus an `onboardingSkill`. Note that skills changes require a new ZIP and review, so keep them stable.
13. **References:** add [S6] Managing app permissions, [S7] Sites-hosted plugins, [S8] Organization verification, [S11] Auth doc (RFC 9207 / redirect URIs), and [S3] the review requirements page.

---

## Sources (all fetched 2026-10-10)

- [S1] OpenAI, Plugin guidelines: https://developers.openai.com/plugins/plugin-guidelines.md
- [S2] OpenAI, Upload and submit your plugin: https://developers.openai.com/plugins/deploy/submission.md
- [S3] OpenAI, Remote MCP server review requirements: https://developers.openai.com/plugins/deploy/app-review.md
- [S4] OpenAI Help Center, Plugins in ChatGPT (page said "Updated: 8 minutes ago"): https://help.openai.com/en/articles/20001256-plugins-in-chatgpt
- [S5] OpenAI Help Center, Developer mode and MCP apps in ChatGPT ("Updated: 2 days ago"): https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- [S6] OpenAI Help Center, Managing app permissions in ChatGPT ("Updated: 9 days ago"): https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt
- [S7] OpenAI Help Center, Hosting a plugin with ChatGPT Sites ("Updated: 6 days ago"): https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites
- [S8] OpenAI Help Center, API Organization Verification ("Updated: 2 months ago"): https://help.openai.com/en/articles/10910291-api-organization-verification
- [S9] OpenAI Developer Community, review-time thread (support reply 2026-09-01): https://community.openai.com/t/how-long-does-the-plugin-review-and-approval-process-usually-take/1388430
- [S10] reviewtimes.fyi (third-party tracker; median approval 8 d, rejection 3 d; small sample): https://reviewtimes.fyi/chatgpt
- [S11] OpenAI, Authentication / Security & Privacy / Reference: https://developers.openai.com/plugins/build/auth.md · https://developers.openai.com/plugins/guides/security-privacy.md · https://developers.openai.com/plugins/reference.md
- [S12] OpenAI Help Center, Connected apps in ChatGPT ("Updated: 24 hours ago"): https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt
- [S13] OpenAI Help Center, ChatGPT supported countries (via search snippet only): https://help.openai.com/en/articles/7947663-chatgpt-supported-countries
- [S14] OpenAI, Plugin submission errors: https://developers.openai.com/plugins/deploy/submission-errors.md
- [S15] OpenAI, Package your plugin (MCP auth config in `mcp.json`): https://developers.openai.com/plugins/build/plugins.md
- [S16] OpenAI Developer Community, iOS OAuth with GPT Actions (2024-12-16, user reports, no staff): https://community.openai.com/t/trouble-completing-oauth-authorization-for-google-calendar-actions-on-ios-chatgpt-app-but-works-on-web-desktop-app/1057646
- Index: https://developers.openai.com/plugins/llms.txt (spec [R1]); combined docs https://developers.openai.com/plugins/llms-full.txt ([R4]).
