import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { HttpFunction } from '@google-cloud/functions-framework';
// Keep the callback's cold-start imports small: no tracing/export SDK initialization.
import { createLogger } from '@pixelwar/shared/observability/logger';

interface Options {
  environment?: string;
  publicKey?: string;
  now?: () => number;
  log?: ReturnType<typeof createLogger>;
}

function discordKey(hex?: string): KeyObject | undefined {
  if (!hex || !/^[a-f0-9]{64}$/i.test(hex)) return undefined;
  // SubjectPublicKeyInfo wrapper for a raw 32-byte Ed25519 Discord public key.
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]),
    format: 'der', type: 'spki',
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Temporary dev callback probe, not the business discord-proxy or a Pub/Sub worker. */
export function createDiscordHelloHandler(options: Options): HttpFunction {
  const key = discordKey(options.publicKey);
  const now = options.now ?? Date.now;
  const log = options.log ?? createLogger({
    serviceName: 'discord-hello', projectId: process.env.GOOGLE_CLOUD_PROJECT ?? '',
  });
  let firstRequest = true;

  return (req, res): void => {
    const started = now();
    const cold = firstRequest;
    firstRequest = false;
    const completed = (event: string) => log('INFO',
      `Discord probe handled; handler_ms=${now() - started}; first_request=${cold}.`, { event_type: event });

    if (options.environment !== 'dev' || !key) {
      log('ERROR', 'Discord probe is disabled or misconfigured.', { event_type: 'discord.probe.unavailable' });
      res.status(503).json({ error: 'Probe unavailable.' });
      return;
    }
    if (req.path !== '/discord/interactions') {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' });
      return;
    }

    const signature = req.get('X-Signature-Ed25519') ?? '';
    const timestamp = req.get('X-Signature-Timestamp') ?? '';
    const rawBody = req.rawBody;
    // Never reconstruct the signed body from req.body: Discord signs its exact raw bytes.
    const valid = /^[a-f0-9]{128}$/i.test(signature) && /^\d{1,12}$/.test(timestamp) &&
      Math.abs(started - Number(timestamp) * 1000) <= 300_000 && Buffer.isBuffer(rawBody) &&
      verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signature, 'hex'));
    if (!valid || !rawBody) {
      log('WARNING', 'Discord signature rejected.', { event_type: 'discord.probe.invalid_signature' });
      res.status(401).json({ error: 'Invalid request signature.' });
      return;
    }

    let interaction: unknown;
    try { interaction = JSON.parse(rawBody.toString('utf8')); }
    catch {
      res.status(400).json({ error: 'Invalid JSON.' });
      return;
    }
    if (!record(interaction)) {
      res.status(400).json({ error: 'Invalid interaction.' });
      return;
    }
    if (interaction.type === 1) {
      completed('discord.probe.ping');
      res.status(200).json({ type: 1 });
      return;
    }
    if (interaction.type !== 2 || !record(interaction.data)) {
      res.status(400).json({ error: 'Unsupported interaction.' });
      return;
    }
    const data = interaction.data;
    const option = Array.isArray(data.options) && data.options.length === 1 ? data.options[0] : undefined;
    let content = 'Seule la commande temporaire /hello est disponible pendant ce test.';
    let flags = 64;
    if (data.name === 'hello' && data.type === 1) {
      const name = record(option) && option.type === 3 && option.name === 'nom' &&
        typeof option.value === 'string' ? option.value.trim() : '';
      content = 'Le paramètre nom est obligatoire (1 à 80 caractères).';
      if (name.length > 0 && name.length <= 80) {
        content = `Hello ${name} !`;
        flags = 0;
      }
    }
    completed('discord.probe.command');
    // No token, name, user ID or body in logs; user text must never trigger mentions.
    res.status(200).json({ type: 4, data: { content, flags, allowed_mentions: { parse: [] } } });
  };
}

export const handleDiscordHello = createDiscordHelloHandler({
  environment: process.env.APP_ENV, publicKey: process.env.DISCORD_PUBLIC_KEY,
});
