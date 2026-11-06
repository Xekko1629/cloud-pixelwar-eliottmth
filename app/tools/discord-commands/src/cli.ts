import { pathToFileURL } from 'node:url';
import { readTarget, registrationPlan, registerCommands } from './register';

export async function run(
  args: string[], env: NodeJS.ProcessEnv, print: (message: string) => void = console.log,
  register: typeof registerCommands = registerCommands,
): Promise<void> {
  let apply = false;
  let confirmation = '';
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--apply' && !apply) apply = true;
    else if (argument === '--confirm-application-id' && !confirmation && args[index + 1]) confirmation = args[++index];
    else throw new Error('Usage: discord:commands [--apply --confirm-application-id ID]');
  }
  const target = readTarget(env);
  const plan = registrationPlan(target);
  if (!apply) {
    if (confirmation) throw new Error('Confirmation requires --apply.');
    print(JSON.stringify({ mode: 'dry-run', ...plan }, null, 2));
    return;
  }
  await register(target, env.DISCORD_BOT_TOKEN ?? '', confirmation);
  print(`Registered ${plan.commands.length} commands for ${target.environment} application ${target.applicationId}.`);
}

export async function main(
  args: string[], env: NodeJS.ProcessEnv,
  print: (message: string) => void = console.log,
  report: (message: string) => void = console.error,
): Promise<number> {
  try {
    await run(args, env, print);
    return 0;
  } catch {
    // Even an unexpected error must not echo injected credentials or a raw HTTP response.
    report('Discord command registration failed. Check configuration, permissions and connectivity; no credentials were logged.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
