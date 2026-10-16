import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer, type McpDeps } from './tools.js';

/**
 * Stateless Streamable HTTP: a fresh server + transport per request, so any replica can
 * answer any request. Requires bearer auth upstream (req.auth).
 */
export function mcpHandler(deps: McpDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) {
      res.status(401).end();
      return;
    }
    const server = buildMcpServer(deps, req.auth);
    logToolCalls(req, res);
    logUnsupportedProtocol(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('mcp request failed', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
}

/**
 * One log line per tools/call: tool name, duration, and on failure the error message (our own
 * text, or the SDK's input validation error). Never arguments or results: those carry site content.
 */
function logToolCalls(req: Request, res: Response): void {
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
  const end = res.end.bind(res) as (...a: unknown[]) => Response;
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
        console.log(JSON.stringify({ t: new Date().toISOString(), event: 'tool_call', tool, ms: Date.now() - start, ok: Boolean(r) && !error, ...(error ? { error: error.slice(0, 200) } : {}), ...(r ? {} : { note: 'no reply' }) }));
      }
    } catch {
      // Logging must never break a response.
    }
    return end(chunk, ...rest);
  }) as typeof res.end;
}

/**
 * A client asking for an MCP protocol version this SDK doesn't support gets a 400. Logs the version,
 * the JSON-RPC methods and the client (never message content), to see which clients need an SDK update.
 */
function logUnsupportedProtocol(req: Request): void {
  const version = req.get('mcp-protocol-version');
  const msgs = (Array.isArray(req.body) ? req.body : [req.body]) as { method?: string; params?: { protocolVersion?: unknown } }[];
  const requested = msgs.map((m) => m?.params?.protocolVersion).find((v) => typeof v === 'string') as string | undefined;
  const unsupported = [version, requested].filter((v): v is string => !!v && !SUPPORTED_PROTOCOL_VERSIONS.includes(v));
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
export function mcpMethodNotAllowed(_req: Request, res: Response): void {
  res.status(405).set('allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
}
