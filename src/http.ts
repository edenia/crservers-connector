import express, { type Express } from 'express';
import { createOAuthMetadata, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { ConnectorOAuthProvider } from './auth/provider.js';
import { mcpHandler, mcpMethodNotAllowed } from './mcp/handler.js';
import type { McpDeps } from './mcp/tools.js';
import type { PreviewService } from './preview/preview.js';
import type { ApprovalService } from './approvals/approvals.js';
import { clientAreaEvents } from './auth/events.js';
import { clientAreaApi, type ClientApiDeps } from './auth/clientapi.js';
import type { SiteRepo } from './sites.js';
import type { Pool } from 'pg';
import { LOGO_SVG } from './ui/logo.js';
import { LOGO_PATH, landingPage, pickLang } from './ui/page.js';

export const SCOPES_SUPPORTED = ['site', 'offline_access'];

export interface AppDeps {
  provider: ConnectorOAuthProvider;
  issuer: string;
  mcpUrl: string;
  mcp: McpDeps;
  preview: PreviewService;
  approvals: ApprovalService;
  /** Data for the client area's "Asistente de IA" page (signed with REQ_KEY). */
  clientApi?: ClientApiDeps;
  /** Lifecycle events from the client area (signed with REQ_KEY). */
  events?: { pool: Pool; sites: SiteRepo; reqKey: Buffer };
}

/**
 * HTTP surface: OAuth (SDK router + our metadata additions), the client-area callback,
 * health, and the MCP endpoint behind bearer auth.
 */
export function createApp(d: AppDeps): Express {
  const app = express();
  app.set('trust proxy', 1); // behind the k8s ingress
  app.disable('x-powered-by');

  // One JSON line per request. Path only: query strings carry codes and state.
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      console.log(
        JSON.stringify({
          t: new Date().toISOString(),
          m: req.method,
          // originalUrl keeps the mount path (req.path is relative inside the SDK's routers); drop the query.
          // Preview tokens are bearer secrets: never log them.
          p: req.originalUrl.split('?')[0]!.replace(/^\/p\/[^/]+/, '/p/:token'),
          s: res.statusCode,
          ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
          ua: (req.get('user-agent') ?? '').slice(0, 80),
          ip: req.ip,
        }),
      );
    });
    next();
  });

  const issuerUrl = new URL(d.issuer);
  const resourceServerUrl = new URL(d.mcpUrl);

  // Our metadata first: the SDK's lacks RFC 9207 `iss` support and CIMD advertisement.
  // RFC 8414: `issuer` must equal what clients derive from our origin, with no trailing slash
  // (URL.href adds one). Strict clients reject a mismatch.
  const issuer = d.issuer.replace(/\/+$/, '');
  const metadata = {
    ...createOAuthMetadata({ provider: d.provider, issuerUrl, scopesSupported: SCOPES_SUPPORTED }),
    issuer,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  };
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.set('cache-control', 'public, max-age=300').json(metadata);
  });

  // Ours too, so authorization_servers carries the same slash-free issuer.
  const resourceMetadata = {
    resource: d.mcpUrl,
    authorization_servers: [issuer],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: 'CR Servers',
  };
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    res.set('cache-control', 'public, max-age=300').json(resourceMetadata);
  });

  app.use(mcpAuthRouter({ provider: d.provider, issuerUrl, resourceServerUrl, scopesSupported: SCOPES_SUPPORTED, resourceName: 'CR Servers' }));

  // One callback for both client-area round trips: new connections and approval sign-ins.
  app.get('/oauth/callback', (req, res, next) => {
    (async () => {
      if (await d.approvals.ownsRid(req.query.rid)) return d.approvals.callback(req, res);
      return d.provider.clientAreaCallback(req, res);
    })().catch(next);
  });

  if (d.events) {
    const handler = clientAreaEvents({ ...d.events, provider: d.provider });
    app.post('/client-area/events', express.raw({ type: 'application/json', limit: '4kb' }), (req, res, next) => {
      handler(req, res).catch(next);
    });
  }

  if (d.clientApi) app.use('/client-area/api', clientAreaApi(d.clientApi));

  app.get('/approve/:id', (req, res, next) => {
    d.approvals.show(req, res).catch(next);
  });
  app.post('/approve/:id', express.urlencoded({ extended: false, limit: '4kb' }), (req, res, next) => {
    d.approvals.decide(req, res).catch(next);
  });

  app.get('/', (_req, res) => {
    res.type('html').send(landingPage(d.mcpUrl, pickLang(_req.get('accept-language'))));
  });

  // Draft previews: sandboxed, noindex, token in the path (src/preview/preview.ts).
  app.use('/p', (req, res, next) => {
    d.preview.handle(req, res).catch(next);
  });

  app.get(LOGO_PATH, (_req, res) => {
    res.set('cache-control', 'public, max-age=86400').type('image/svg+xml').send(LOGO_SVG);
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  const bearer = requireBearerAuth({
    verifier: d.provider,
    requiredScopes: ['site'],
    resourceMetadataUrl: `${d.issuer}/.well-known/oauth-protected-resource/mcp`,
  });

  // 5 MB of file content per write call is ~6.7 MB once base64-encoded inside JSON-RPC.
  app.post('/mcp', bearer, express.json({ limit: '8mb' }), mcpHandler(d.mcp));
  app.get('/mcp', mcpMethodNotAllowed);
  app.delete('/mcp', mcpMethodNotAllowed);

  return app;
}
