import { setTimeout } from 'node:timers/promises';
import { commandDefinitions } from './definitions';

export interface Target { environment: 'dev' | 'prd'; applicationId: string; guildId?: string }
const snowflake = /^[1-9]\d{0,19}$/;

export function readTarget(env: NodeJS.ProcessEnv): Target {
  if (env.APP_ENV !== 'dev' && env.APP_ENV !== 'prd') throw new Error('APP_ENV must be dev or prd.');
  const target: Target = {
    environment: env.APP_ENV,
    applicationId: env.DISCORD_APPLICATION_ID ?? '',
    guildId: env.DISCORD_GUILD_ID,
  };
  validateTarget(target);
  return target;
}

function validateTarget(target: Target): void {
  if (target.environment !== 'dev' && target.environment !== 'prd') throw new Error('Invalid environment.');
  if (!snowflake.test(target.applicationId)) throw new Error('Invalid DISCORD_APPLICATION_ID.');
  if (target.environment === 'dev' && !snowflake.test(target.guildId ?? '')) {
    throw new Error('Dev requires a valid DISCORD_GUILD_ID.');
  }
  if (target.environment === 'prd' && target.guildId !== undefined) {
    throw new Error('Prd uses global commands: unset DISCORD_GUILD_ID.');
  }
}

export function registrationPlan(target: Target) {
  validateTarget(target);
  const scope = target.environment === 'dev' ? `/guilds/${target.guildId}` : '';
  return {
    url: `https://discord.com/api/v10/applications/${target.applicationId}${scope}/commands`,
    commands: commandDefinitions(target.environment === 'prd'),
  };
}

interface Dependencies {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
}

/** Add/update only this guild command; never bulk-overwrite the existing catalogue. */
export function helloRegistrationPlan(target: Target) {
  const plan = registrationPlan(target);
  if (target.environment !== 'dev') throw new Error('The temporary hello command is dev-only.');
  return {
    url: plan.url,
    method: 'POST' as const,
    commands: [{
      type: 1, name: 'hello', description: 'Tester le callback Discord de développement.',
      default_member_permissions: null,
      options: [{ type: 3, name: 'nom', description: 'Nom à saluer.', required: true, min_length: 1, max_length: 80 }],
    }],
  };
}

export async function registerHelloCommand(
  target: Target, token: string, confirmation: string,
  dependencies: Dependencies = { fetch: globalThis.fetch, sleep: async (ms) => { await setTimeout(ms); } },
): Promise<void> {
  const plan = helloRegistrationPlan(target);
  await sendRegistration(target, token, confirmation, dependencies, plan.url, plan.method, plan.commands[0]);
}

/** Deterministic PUT: replaces every command in this scope, including unlisted commands. */
export async function registerCommands(
  target: Target,
  token: string,
  confirmation: string,
  dependencies: Dependencies = { fetch: globalThis.fetch, sleep: async (ms) => { await setTimeout(ms); } },
): Promise<void> {
  const plan = registrationPlan(target);
  await sendRegistration(target, token, confirmation, dependencies, plan.url, 'PUT', plan.commands);
}

async function sendRegistration(
  target: Target, token: string, confirmation: string, dependencies: Dependencies,
  url: string, method: 'PUT' | 'POST', payload: unknown,
): Promise<void> {
  if (confirmation !== target.applicationId) throw new Error('Confirm the target application ID before applying.');
  if (!token || /\s/.test(token)) throw new Error('A nonempty DISCORD_BOT_TOKEN without whitespace is required.');
  const body = JSON.stringify(payload);
  // Four attempts maximum. Never print the token, raw errors or Discord response bodies.
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body, redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error('Discord request failed or timed out; verify the target before retrying.');
    }
    if (response.ok) { await response.body?.cancel(); return; }
    if (response.status === 429) {
      const delay = await retryDelay(response);
      if (attempt === 3) throw new Error('Discord rate limit persists after four attempts.');
      await dependencies.sleep(delay);
    } else {
      await response.body?.cancel();
      if (response.status >= 500 && attempt < 3) {
        await dependencies.sleep(1_000 * 2 ** attempt);
      } else {
        throw new Error(`Discord command registration failed (HTTP ${response.status}).`);
      }
    }
  }
}

async function retryDelay(response: Response): Promise<number> {
  const header = response.headers.get('Retry-After');
  let seconds: unknown = header === null || header.trim() === '' ? undefined : Number(header);
  if (seconds === undefined) {
    try { seconds = ((await response.json()) as { retry_after?: unknown } | null)?.retry_after; }
    catch { /* Reject an unparseable rate limit rather than retrying blindly. */ }
  } else {
    await response.body?.cancel();
  }
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 60) {
    throw new Error('Discord retry delay missing, invalid or above 60 seconds; retry later.');
  }
  return Math.max(1, Math.ceil(seconds * 1_000));
}
