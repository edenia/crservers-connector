import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
  const end = res.end.bind(res) as (...a: unknown[]) => Response;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      const replies = text ? ([] as { id?: unknown; result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message?: string } }[]).concat(JSON.parse(text)) : [];
      for (const [id, tool] of calls) {
        const r = replies.find((x) => String(x.id) === id);
        const error = r?.error?.message ?? (r?.result?.isError ? String(r.result.content?.[0]?.text ?? '').split('\n')[0] : undefined);
        console.log(JSON.stringify({ t: new Date().toISOString(), event: 'tool_call', tool, ms: Date.now() - start, ok: Boolean(r) && !error, ...(error ? { error: error.slice(0, 200) } : {}), ...(r ? {} : { note: 'no reply' }) }));
      }
    } catch {
      // Logging must never break a response.
    }
    return end(chunk as never, ...(rest as never[]));
  }) as typeof res.end;
}

/** GET (SSE stream) and DELETE (session end) aren't used in stateless mode. */
export function mcpMethodNotAllowed(_req: Request, res: Response): void {
  res.status(405).set('allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
}
