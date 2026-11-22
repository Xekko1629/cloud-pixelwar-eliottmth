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

/** Slash commands that can be registered alone, without the PUT that replaces the catalogue. */
export type TargetedCommand = 'draw' | 'admin' | 'get';

/** Offline preview: the exact POST/PATCH decision requires an authorized GET. */
export function targetedRegistrationPlan(target: Target, name: TargetedCommand) {
  const plan = registrationPlan(target);
  if (target.environment !== 'dev') throw new Error(`Targeted ${name} registration is dev-only.`);
  const command = plan.commands.find((entry) => entry.type === 1 && entry.name === name);
  if (!command) throw new Error(`Missing ${name} command definition.`);
  return {
    url: plan.url, strategy: 'GET_THEN_POST_OR_PATCH' as const,
    commands: [command],
  };
}

export const drawRegistrationPlan = (target: Target) => targetedRegistrationPlan(target, 'draw');
export const adminRegistrationPlan = (target: Target) => targetedRegistrationPlan(target, 'admin');
export const getRegistrationPlan = (target: Target) => targetedRegistrationPlan(target, 'get');

export async function registerDrawCommand(
  target: Target, token: string, confirmation: string,
  dependencies: Dependencies = { fetch: globalThis.fetch, sleep: async (ms) => { await setTimeout(ms); } },
): Promise<void> {
  await registerTargetedCommand(target, token, confirmation, 'draw', dependencies);
}

export async function registerAdminCommand(
  target: Target, token: string, confirmation: string,
  dependencies: Dependencies = { fetch: globalThis.fetch, sleep: async (ms) => { await setTimeout(ms); } },
): Promise<void> {
  await registerTargetedCommand(target, token, confirmation, 'admin', dependencies);
}

export async function registerGetCommand(
  target: Target, token: string, confirmation: string,
  dependencies: Dependencies = { fetch: globalThis.fetch, sleep: async (ms) => { await setTimeout(ms); } },
): Promise<void> {
  await registerTargetedCommand(target, token, confirmation, 'get', dependencies);
}

/** GET the scope, then POST the command if absent or PATCH its validated ID: nothing else changes. */
export async function registerTargetedCommand(
  target: Target, token: string, confirmation: string, name: TargetedCommand,
  dependencies: Dependencies = { fetch: globalThis.fetch, sleep: async (ms) => { await setTimeout(ms); } },
): Promise<void> {
  const plan = targetedRegistrationPlan(target, name);
  validateApply(target, token, confirmation);
  const response = await discordRequest(token, dependencies, plan.url, 'GET');
  let catalogue: unknown;
  try { catalogue = await response.json(); }
  catch { throw new Error('Invalid Discord command catalogue.'); }
  // Do not use an unvalidated server-provided ID in a URL or log raw responses.
  if (!Array.isArray(catalogue) || catalogue.length > 200 || !catalogue.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const command = entry as Record<string, unknown>;
    return typeof command.id === 'string' && snowflake.test(command.id) && BigInt(command.id) <= 0xffffffffffffffffn &&
      typeof command.name === 'string' && command.name.length > 0 && command.name.length <= 32 &&
      [1, 2, 3].includes((command.type === undefined ? 1 : command.type) as number) &&
      (command.application_id === undefined || command.application_id === target.applicationId) &&
      (command.guild_id === undefined || command.guild_id === target.guildId);
  })) throw new Error('Invalid Discord command catalogue.');
  const matches = (catalogue as { id: string; type: number; name: string }[])
    .filter((command) => (command.type ?? 1) === 1 && command.name === name);
  if (matches.length > 1) throw new Error(`Ambiguous Discord ${name} command catalogue.`);
  if (matches.length === 0) {
    await sendRegistration(target, token, confirmation, dependencies, plan.url, 'POST', plan.commands[0]);
  } else {
    // Discord's edit endpoint does not accept a command type change.
    const { type: _type, ...update } = plan.commands[0];
    await sendRegistration(target, token, confirmation, dependencies, `${plan.url}/${matches[0].id}`, 'PATCH', update);
  }
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
  url: string, method: 'PUT' | 'POST' | 'PATCH', payload: unknown,
): Promise<void> {
  validateApply(target, token, confirmation);
  const response = await discordRequest(token, dependencies, url, method, payload);
  await response.body?.cancel();
}

function validateApply(target: Target, token: string, confirmation: string): void {
  if (confirmation !== target.applicationId) throw new Error('Confirm the target application ID before applying.');
  if (!token || /\s/.test(token)) throw new Error('A nonempty DISCORD_BOT_TOKEN without whitespace is required.');
}

async function discordRequest(
  token: string, dependencies: Dependencies, url: string, method: 'GET' | 'PUT' | 'POST' | 'PATCH', payload?: unknown,
): Promise<Response> {
  // Four attempts maximum. Never print the token, raw errors or Discord response bodies.
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }),
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error('Discord request failed or timed out; verify the target before retrying.');
    }
    if (response.ok) return response;
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
  throw new Error('Discord request attempts exhausted.');
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
