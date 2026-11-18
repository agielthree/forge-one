// The HTTP server: one process, one store. Routes git smart HTTP, REST v3,
// GraphQL and MCP from the same in-memory forge. Every JSON reply carries a
// non-empty X-GitHub-Request-Id; every reply is application/json unless it is
// a git smart-HTTP body.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fetchV2, infoRefs, lsRefsV2, receivePack } from './git-http.ts';
import { decodePktLines } from './util.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const authorized = (req: IncomingMessage): boolean => {
    const auth = req.headers.authorization ?? '';
    if (token !== '') return auth === `Bearer ${token}`;
    return auth.startsWith('Bearer ') && auth.length > 7;
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      process.stderr.write(`[forge] unhandled error: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json', 'X-GitHub-Request-Id': `req-${++requestCounter}` });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `req-${++requestCounter}`;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    const sendJson = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): void => {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'X-GitHub-Request-Id': requestId, ...extraHeaders };
      if (status === 204 || body === null || body === undefined) {
        res.writeHead(status, headers);
        res.end();
        return;
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };

    // The boot probe: no auth, no JSON contract beyond {ok:true}.
    if (pathname === '/healthz') {
      if (method !== 'GET') {
        sendJson(404, { message: 'Not Found' });
        return;
      }
      sendJson(200, { ok: true });
      return;
    }

    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
    if (gitMatch) {
      if (!authorized(req)) {
        sendJson(401, { message: 'Requires authentication' });
        return;
      }
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const tail = gitMatch[3]!;
      const repo = forge.getRepo(owner, repoName);
      const body = await readBody(req);
      if (method === 'GET' && tail === 'info/refs') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        const gitProtocol = req.headers['git-protocol'];
        const reply = infoRefs(forge, repo, service, typeof gitProtocol === 'string' ? gitProtocol : undefined);
        res.writeHead(reply.status, { 'content-type': reply.contentType, 'X-GitHub-Request-Id': requestId });
        res.end(reply.body);
        return;
      }
      if (method === 'POST' && tail === 'git-upload-pack') {
        if (!repo) {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        const decoded = decodePktLines(body);
        let command = '';
        if (!decoded.error) {
          for (const packet of decoded.packets) {
            if (packet.kind === 'data') {
              command = packet.payload.toString('utf8').replace(/\n$/, '');
              break;
            }
          }
        }
        const reply =
          command === 'command=ls-refs'
            ? lsRefsV2(forge, repo, body)
            : command === 'command=fetch'
              ? fetchV2(forge, repo, body)
              : { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: decoded.error ?? 'bad upload-pack request' }), 'utf8') };
        res.writeHead(reply.status, { 'content-type': reply.contentType, 'X-GitHub-Request-Id': requestId });
        res.end(reply.body);
        return;
      }
      if (method === 'POST' && tail === 'git-receive-pack') {
        if (!repo) {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        const reply = receivePack(forge, repo, body);
        res.writeHead(reply.status, { 'content-type': reply.contentType, 'X-GitHub-Request-Id': requestId });
        res.end(reply.body);
        return;
      }
      sendJson(404, { message: 'Not Found' });
      return;
    }

    if (pathname === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(404, { message: 'Not Found' });
        return;
      }
      if (!authorized(req)) {
        sendJson(401, { message: 'Requires authentication' });
        return;
      }
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(400, { errors: [{ message: 'Malformed JSON body' }] });
        return;
      }
      const reply = handleGraphQL(forge, parsed);
      sendJson(reply.status, reply.body);
      return;
    }

    if (pathname === '/mcp') {
      if (method !== 'POST') {
        sendJson(404, { message: 'Not Found' });
        return;
      }
      if (!authorized(req)) {
        sendJson(401, { message: 'Requires authentication' });
        return;
      }
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        const body = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
        sendJson(400, body);
        return;
      }
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }
      const reply = handleMcp(forge, parsed, headers);
      if (reply.body === null) {
        res.writeHead(reply.status, { 'content-type': 'application/json', 'X-GitHub-Request-Id': requestId });
        res.end();
        return;
      }
      sendJson(reply.status, reply.body);
      return;
    }

    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      if (!authorized(req)) {
        sendJson(401, { message: 'Requires authentication' });
        return;
      }
      const raw = await readBody(req);
      let parsed: unknown;
      if (raw.length > 0) {
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(400, { message: 'Malformed JSON body' });
          return;
        }
      }
      const reply = handleRest(forge, {
        method,
        pathname,
        query: url.searchParams,
        body: parsed,
        host: req.headers.host ?? '127.0.0.1',
      });
      sendJson(reply.status, reply.body, reply.headers ?? {});
      return;
    }

    sendJson(404, { message: 'Not Found' });
  }

  return server;
}
