// forge-one: a GitHub-compatible git forge in one process — git smart HTTP,
// REST v3, GraphQL and MCP from a single in-memory store. Node 22, stdlib only.
//
// Lifecycle (the entry <-> env contract):
//   1. MAKEFUN_ENV_URL names the env's origin. With it set, bind an ephemeral
//      port, POST {port} to $MAKEFUN_ENV_URL/register, then poll GET
//      $MAKEFUN_ENV_URL/done until {"done": true} and exit 0.
//   2. Without it, run standalone: listen on $PORT (or an ephemeral port) and
//      serve until killed, so the kit's local suite can dial it directly.

import { createApp } from './src/app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  const requestedPort = Number(process.env.PORT ?? 0);
  const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind a TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  if (ENV_URL === '') {
    // Standalone: serve until killed (the local suite dials this port).
    return;
  }
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  if (ENV_URL !== '') process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
