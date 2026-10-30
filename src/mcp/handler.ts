import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
  type McpHandlerRequestOptions,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcpServer, type McpDeps, type Trace } from './tools.js';

/**
 * Every revision createMcpHandler serves: SUPPORTED_PROTOCOL_VERSIONS is the initialize-handshake
 * (2025-era) list; 2026-07-28 is the per-request era (the SDK keeps that list internal).
 */
const SERVED_PROTOCOL_VERSIONS: readonly string[] = [...SUPPORTED_PROTOCOL_VERSIONS, '2026-07-28'];

/**
 * Stateless Streamable HTTP for both protocol eras, a fresh server per request so any replica can
 * answer any request. Requires bearer auth upstream (req.auth).
 * - 2026-07-28 clients (ChatGPT's Codex client opens with server/discover): the SDK's modern handler.
 * - 2025-era clients (initialize handshake): a stateless transport answering plain JSON, as before
 *   the SDK v2 upgrade (the SDK's own stateless fallback answers as an event stream).
 */
export function mcpHandler(deps: McpDeps) {
  // Each request's trace, keyed by the web Request the SDK hands to the server factory.
  const traces = new WeakMap<globalThis.Request, Trace>();
  const factory: McpServerFactory = ({ authInfo, requestInfo }) => buildMcpServer(deps, authInfo!, (requestInfo && traces.get(requestInfo)) ?? {});
  // Also called for requests the SDK rejects (bad headers, unsupported version): one line, no stack.
  const onerror = (e: Error) => console.warn(JSON.stringify({ t: new Date().toISOString(), event: 'mcp_request_error', error: e.message.slice(0, 200) }));
  const modern = createMcpHandler(factory, { legacy: 'reject', onerror });
  const legacy = async (request: globalThis.Request, options?: McpHandlerRequestOptions): Promise<Response> => {
    const server = await factory({ era: 'legacy', authInfo: options?.authInfo, requestInfo: request });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, options);
    } finally {
      void transport.close();
      void server.close();
    }
  };
  return async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    if (!req.auth) {
      res.status(401).end();
      return;
    }
    const trace: Trace = {};
    logToolCalls(req, res, trace, deps);
    logInitialize(req, deps);
    logUnsupportedProtocol(req);
    const serve = toNodeHandler({
      fetch: async (request, options) => {
        traces.set(request, trace);
        return (await isLegacyRequest(request, options?.parsedBody)) ? legacy(request, options) : modern.fetch(request, options);
      },
    }, { onerror });
    await serve(req, res, req.body);
  };
}

/**
 * One log line per tools/call: tool name, duration, and on failure the error message (our own
 * text, or the SDK's input validation error). Never arguments or results: those carry site content.
 * The log line also carries the random reference id shown to the user on failure (#56); which site,
 * service and client it belongs to goes only to the support records (src/db/support.ts, 30 days),
 * so request logs stay free of personal data.
 */
function logToolCalls(req: ExpressRequest, res: ExpressResponse, trace: Trace, deps: McpDeps): void {
  const msgs = (Array.isArray(req.body) ? req.body : [req.body]) as { method?: string; id?: unknown; params?: { name?: unknown } }[];
  const calls = new Map(msgs.filter((m) => m?.method === 'tools/call').map((m) => [String(m.id), String(m.params?.name ?? '')]));
  if (!calls.size) return;
  const start = Date.now();
  // The SDK may write the body in pieces (or as a text/event-stream); collect everything.
  const chunks: Buffer[] = [];
  const collect = (c: unknown) => {
    if (typeof c === 'string') chunks.push(Buffer.from(c));
    else if (c instanceof Uint8Array) chunks.push(Buffer.from(c));
  };
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    collect(chunk);
    return write(chunk, ...rest);
  }) as typeof res.write;
  const end = res.end.bind(res) as (...a: unknown[]) => ExpressResponse;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    collect(chunk);
    try {
      const text = Buffer.concat(chunks).toString('utf8');
      // JSON body, or SSE: "data: {...}" lines.
      const bodies = text.trimStart().startsWith('{') || text.trimStart().startsWith('[') ? [text] : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5));
      const replies = bodies.flatMap((b) => {
        try {
          return ([] as Reply[]).concat(JSON.parse(b));
        } catch {
          return [];
        }
      });
      for (const [id, tool] of calls) {
        const r = replies.find((x) => String(x.id) === id);
        const error = r?.error?.message ?? (r?.result?.isError ? String(r.result.content?.[0]?.text ?? '').split('\n')[0] : undefined);
        console.log(JSON.stringify({
          t: new Date().toISOString(),
          event: 'tool_call',
          tool,
          ms: Date.now() - start,
          ok: Boolean(r) && !error,
          ...(error ? { error: error.slice(0, 200) } : {}),
          ...(r ? {} : { note: 'no reply' }),
          ...(trace.ref ? { ref: trace.ref } : {}),
        }));
        deps.support?.record({
          kind: 'tool_call',
          tool,
          ok: Boolean(r) && !error,
          error,
          ref: trace.ref,
          siteIds: trace.siteId ? [trace.siteId] : [],
          serviceId: trace.serviceId,
          clientId: req.auth?.clientId,
        });
      }
    } catch {
      // Logging must never break a response.
    }
    return end(chunk, ...rest);
  }) as typeof res.end;
}

/**
 * Session start: initialize (2025-era clients), or server/discover (2026-07-28 clients, which have
 * no handshake and carry clientInfo in _meta). The log line says which app connected (its
 * self-reported name and version); the support record adds the OAuth client and the granted site
 * ids, so support can see "connected, then nothing arrived" for a customer.
 */
function logInitialize(req: ExpressRequest, deps: McpDeps): void {
  type Info = { name?: unknown; version?: unknown };
  const msgs = (Array.isArray(req.body) ? req.body : [req.body]) as { method?: string; params?: { clientInfo?: Info; _meta?: Record<string, unknown> } }[];
  const init = msgs.find((m) => m?.method === 'initialize' || m?.method === 'server/discover');
  if (!init) return;
  const info = (init.method === 'initialize' ? init.params?.clientInfo : init.params?._meta?.['io.modelcontextprotocol/clientInfo'] as Info | undefined) ?? {};
  const extra = (req.auth?.extra ?? {}) as { siteIds?: string[] };
  const app = String(info.name ?? '').slice(0, 60);
  const appVersion = String(info.version ?? '').slice(0, 30);
  console.log(JSON.stringify({ t: new Date().toISOString(), event: 'mcp_initialize', app, app_version: appVersion, ...(init.method === 'initialize' ? {} : { via: init.method }) }));
  deps.support?.record({ kind: 'initialize', app, appVersion, clientId: req.auth?.clientId, siteIds: (extra.siteIds ?? []).slice(0, 25) });
}

/**
 * A client asking for an MCP protocol version this SDK doesn't serve gets an error. Logs the version,
 * the JSON-RPC methods and the client (never message content), to see which clients need an SDK update.
 */
function logUnsupportedProtocol(req: ExpressRequest): void {
  const version = req.get('mcp-protocol-version');
  const msgs = (Array.isArray(req.body) ? req.body : [req.body]) as { method?: string; params?: { protocolVersion?: unknown } }[];
  const requested = msgs.map((m) => m?.params?.protocolVersion).find((v) => typeof v === 'string') as string | undefined;
  const unsupported = [version, requested].filter((v): v is string => !!v && !SERVED_PROTOCOL_VERSIONS.includes(v));
  if (!unsupported.length) return;
  console.warn(JSON.stringify({
    t: new Date().toISOString(),
    event: 'mcp_protocol_version_unsupported',
    header: version ?? null,
    initialize_requested: requested ?? null,
    methods: msgs.map((m) => String(m?.method ?? '')).slice(0, 5),
    ua: (req.get('user-agent') ?? '').slice(0, 60),
  }));
}

type Reply = { id?: unknown; result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message?: string } };

/** GET (SSE stream) and DELETE (session end) aren't used in stateless mode. */
export function mcpMethodNotAllowed(_req: ExpressRequest, res: ExpressResponse): void {
  res.status(405).set('allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
}
