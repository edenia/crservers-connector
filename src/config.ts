import { z } from 'zod';

/** Redirect URIs the authorization server accepts (SPEC §5 "Tokens"). Exact match. */
export const DEFAULT_REDIRECT_ALLOWLIST = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
];

const b64urlKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43,}$/, 'must be base64url, at least 32 bytes');

const schema = z.object({
  PORT: z.coerce.number().int().default(8080),
  /** Public origin of this service, e.g. https://connect.crservers.com. Also the OAuth issuer. */
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  DATABASE_URL: z.string().min(1),
  /** HostBill client-area origin, e.g. https://clients.crservers.com (dev: https://hostbill.crservers.net). */
  HOSTBILL_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  HOSTBILL_API_ID: z.string().min(1),
  HOSTBILL_API_KEY: z.string().min(1),
  /** HMAC key for `req`, shared with the HostBill plugin (its ReqKeyCurrent). */
  REQ_KEY: b64urlKey,
  /** AES-256-GCM key for secrets at rest (site FTP passwords). */
  ENCRYPTION_KEY: b64urlKey,
  /** Extra exact redirect URIs, comma-separated (e.g. the one shown in OpenAI's dashboard, or MCP Inspector in dev). */
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
