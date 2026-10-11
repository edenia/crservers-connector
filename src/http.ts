import express, { type Express } from 'express';
import { createOAuthMetadata, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { ConnectorOAuthProvider } from './auth/provider.js';
import { mcpHandler, mcpMethodNotAllowed } from './mcp/handler.js';
import type { McpDeps } from './mcp/tools.js';
import { landingPage } from './ui/page.js';

export const SCOPES_SUPPORTED = ['site', 'offline_access'];

export interface AppDeps {
  provider: ConnectorOAuthProvider;
  issuer: string;
  mcpUrl: string;
  mcp: McpDeps;
}

/**
 * HTTP surface: OAuth (SDK router + our metadata additions), the client-area callback,
 * health, and the MCP endpoint behind bearer auth.
 */
export function createApp(d: AppDeps): Express {
  const app = express();
  app.set('trust proxy', 1); // behind the k8s ingress
  app.disable('x-powered-by');

  const issuerUrl = new URL(d.issuer);
  const resourceServerUrl = new URL(d.mcpUrl);

  // Our metadata first: the SDK's lacks RFC 9207 `iss` support and CIMD advertisement.
  const metadata = {
    ...createOAuthMetadata({ provider: d.provider, issuerUrl, scopesSupported: SCOPES_SUPPORTED }),
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  };
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.set('cache-control', 'public, max-age=300').json(metadata);
  });

  app.use(mcpAuthRouter({ provider: d.provider, issuerUrl, resourceServerUrl, scopesSupported: SCOPES_SUPPORTED, resourceName: 'CR Servers' }));

  app.get('/oauth/callback', (req, res, next) => {
    d.provider.clientAreaCallback(req, res).catch(next);
  });

  app.get('/', (_req, res) => {
    res.type('html').send(landingPage(d.mcpUrl));
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
