import { z } from 'zod';

/** Redirect URIs the authorization server accepts (docs/ARCHITECTURE.md, "Tokens"). Exact match. */
export const DEFAULT_REDIRECT_ALLOWLIST = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  // Cursor (desktop agents sign in through its web callback; https://cursor.com/docs/context/mcp).
  'https://www.cursor.com/agents/mcp/oauth/callback',
  // Warp (desktop app) registers only this app callback. Exact match only: custom schemes in
  // general stay refused. PKCE keeps a code delivered to another app on the device useless.
  'warp://mcp/oauth2callback',
  // Website builders and automation (issue #51). Hosted callbacks: the vendor's servers hold the
  // token, as with Claude and ChatGPT.
  // VERIFIED by the vendor: Make.com MCP Client (https://apps.make.com/c5ZhYquO55e90hoCJ0rzt.md).
  'https://www.make.com/oauth/cb/mcp',
  // UNVERIFIED (third-party sources), staging only until a real sign-in confirms each one; remove
  // any that the staging logs show is not what the tool sends before the next production tag.
  'https://lovable.dev/oauth/callback',
  'https://www.perplexity.ai/rest/connections/oauth_callback',
  'https://enterprise.perplexity.ai/rest/connections/oauth_callback',
  'https://oauth.n8n.cloud/oauth2/callback',
];

const b64urlKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43,}$/, 'must be base64url, at least 32 bytes');

const schema = z.object({
  PORT: z.coerce.number().int().default(8080),
  /** Public origin of this service, e.g. https://connect.crservers.com. Also the OAuth issuer. */
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  DATABASE_URL: z.string().min(1),
  /** CR Servers client area origin, e.g. https://clients.crservers.com. */
  CLIENT_AREA_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  CLIENT_AREA_API_ID: z.string().min(1),
  CLIENT_AREA_API_KEY: z.string().min(1),
  /** HMAC key for `req`, shared with the client-area extension. */
  REQ_KEY: b64urlKey,
  /** AES-256-GCM key for secrets at rest (site FTP passwords). */
  ENCRYPTION_KEY: b64urlKey,
  /** Extra exact redirect URIs, comma-separated (e.g. the one shown in OpenAI's dashboard, or MCP Inspector in dev). */
  /** OpenAI apps directory domain verification token, served at /.well-known/openai-apps-challenge. */
  OPENAI_APPS_CHALLENGE: z.string().trim().default(''),
  EXTRA_REDIRECT_URIS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
});

export type Config = z.infer<typeof schema> & { redirectAllowlist: string[]; mcpUrl: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  return {
    ...parsed,
    redirectAllowlist: [...DEFAULT_REDIRECT_ALLOWLIST, ...parsed.EXTRA_REDIRECT_URIS],
    mcpUrl: `${parsed.PUBLIC_URL}/mcp`,
  };
}
