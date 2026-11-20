import { createPublicKey, verify } from 'node:crypto';
import type { HttpFunction } from '@google-cloud/functions-framework';
import { createLogger } from '@pixelwar/shared/observability/logger';
import { createFunctionTelemetry, type FunctionTelemetry } from '@pixelwar/shared/observability/function';
import { commandEvent, record } from './event';
import { createCommandPublisher, type PublishCommand } from './publisher';

interface Options {
  publicKey?: string;
  applicationId?: string;
  publish?: PublishCommand;
  now?: () => number;
  log?: ReturnType<typeof createLogger>;
  telemetry?: FunctionTelemetry;
}

export function createDiscordProxyHandler(options: Options): HttpFunction {
  const key = options.publicKey && /^[a-f0-9]{64}$/i.test(options.publicKey) ? createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(options.publicKey, 'hex')]),
    format: 'der', type: 'spki',
  }) : undefined;
  const now = options.now ?? Date.now;
  const log = options.log ?? createLogger({ serviceName: 'discord-proxy', projectId: process.env.GOOGLE_CLOUD_PROJECT ?? '' });
  const telemetry = options.telemetry ?? createFunctionTelemetry('discord-proxy', {
    writeLog: options.log ? (line) => {
      const record = JSON.parse(line);
      log(record.severity, record.message ?? 'Telemetry unavailable.', { event_type: record.event_type });
    } : undefined,
  });
  return async (req, res): Promise<void> => {
    if (!key || !options.applicationId || !options.publish) {
      res.status(503).json({ error: 'Proxy unavailable.' }); return;
    }
    if (req.path !== '/discord/interactions') { res.status(404).json({ error: 'Not found.' }); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed.' }); return; }
    const timestamp = req.get('X-Signature-Timestamp') ?? '';
    const signature = req.get('X-Signature-Ed25519') ?? '';
    const body = req.rawBody;
    if (!/^\d{1,12}$/.test(timestamp) || !/^[a-f0-9]{128}$/i.test(signature) ||
        Math.abs(now() - Number(timestamp) * 1000) > 300_000 || !Buffer.isBuffer(body) ||
        !verify(null, Buffer.concat([Buffer.from(timestamp), body]), key, Buffer.from(signature, 'hex'))) {
      log('WARNING', 'Discord signature rejected.', { event_type: 'discord.proxy.invalid_signature' });
      res.status(401).json({ error: 'Invalid request signature.' }); return;
    }
    let interaction: unknown;
    try { interaction = JSON.parse(body.toString('utf8')); } catch {
      res.status(400).json({ error: 'Invalid JSON.' }); return;
    }
    if (!record(interaction)) { res.status(400).json({ error: 'Invalid interaction.' }); return; }
    // Reject signed callbacks for another application, including PINGs.
    if (interaction.application_id !== options.applicationId) {
      res.status(400).json({ error: 'Invalid application.' }); return;
    }
    if (interaction.type === 1) { res.status(200).json({ type: 1 }); return; }
    if (interaction.type !== 2 || !record(interaction.data) || interaction.data.type !== 1 || typeof interaction.data.name !== 'string') {
      res.status(400).json({ error: 'Unsupported interaction.' }); return;
    }
    if (interaction.data.name !== 'draw') {
      res.status(200).json({ type: 4, data: {
        content: 'Seule /draw est disponible sur ce proxy Q2.', flags: 64, allowed_mentions: { parse: [] },
      } }); return;
    }
    let event;
    try { event = commandEvent(interaction, options.applicationId); } catch {
      res.status(400).json({ error: 'Invalid draw interaction.' }); return;
    }
    try {
      // Root trace only after signature/command validation; never trust public trace headers.
      await telemetry.request(event.correlation_id, async (operation) => {
        operation.outcome('error', 'publish');
        await options.publish!(event, operation.attributes());
        operation.outcome('published');
        operation.log('INFO', 'Discord command published.', 'discord.proxy.published');
      });
    } catch {
      // Never log the SDK Error: it may include the message and interaction token.
      log('ERROR', 'Discord command publication failed; delivery may be uncertain.', { event_type: 'discord.proxy.publish_failed' });
      res.status(503).json({ error: 'Command publication unavailable.' }); return;
    }
    res.status(200).json({ type: 5 });
  };
}

export const handleDiscordProxy = createDiscordProxyHandler({
  publicKey: process.env.DISCORD_PUBLIC_KEY, applicationId: process.env.DISCORD_APPLICATION_ID,
  publish: process.env.GOOGLE_CLOUD_PROJECT && process.env.DISCORD_COMMAND_TOPIC
    ? createCommandPublisher(process.env.GOOGLE_CLOUD_PROJECT, process.env.DISCORD_COMMAND_TOPIC) : undefined,
});
