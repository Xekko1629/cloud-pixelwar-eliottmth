import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Test-only loopback API: never forwards a request to Discord. Synthetic tokens only. */
export async function startFakeDiscord() {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const messages = new Map<string, unknown>();
  const responses: { status: number; headers?: Record<string, string>; delayMs?: number }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
    const path = req.url ?? '';
    requests.push({ method: req.method ?? '', path, body });
    const next = responses.shift() ?? { status: 200 };
    if (next.delayMs) await new Promise<void>((resolve) => setTimeout(resolve, next.delayMs));
    if (req.method !== 'PATCH' || !/^\/api\/v10\/webhooks\/\d+\/[^/]+\/messages\/@original$/.test(path)) {
      res.writeHead(405); res.end(); return;
    }
    if (next.status >= 200 && next.status < 300) messages.set(path, body);
    res.writeHead(next.status, { 'Content-Type': 'application/json', ...next.headers });
    // Deliberately sensitive synthetic response, which the client must never log/read.
    res.end(JSON.stringify({ synthetic_secret: 'synthetic-interaction-token', request_url: path }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const localFetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://discord.com' || !url.pathname.startsWith('/api/v10/webhooks/')) {
      throw new Error('Test transport refuses non-Discord URLs');
    }
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  };
  return { requests, messages, responses, fetch: localFetch,
    async close() { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
