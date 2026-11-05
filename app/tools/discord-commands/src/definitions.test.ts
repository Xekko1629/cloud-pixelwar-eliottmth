import { describe, expect, it } from 'vitest';
import { COORDINATE_LIMIT, PALETTE } from '@pixelwar/shared/grid';
import { commandDefinitions, type IntegerOption, type Subcommand } from './definitions';

describe('command definitions', () => {
  it('serializes exactly the four required top-level commands', () => {
    const commands = JSON.parse(JSON.stringify(commandDefinitions(false)));
    expect(commands.map((command: { name: string }) => command.name)).toEqual(['draw', 'get', 'snapshot', 'admin']);
    expect(commands.every((command: { type: number }) => command.type === 1)).toBe(true);
    expect(commands.find((command: { name: string }) => command.name === 'get').options).toBeUndefined();
    expect(commands.find((command: { name: string }) => command.name === 'snapshot').options).toBeUndefined();
  });

  it('uses the shared coordinates and the 16 drawable palette indexes, never 0', () => {
    const options = commandDefinitions(false)[0].options as IntegerOption[];
    expect(options.map(({ name, type, required }) => ({ name, type, required }))).toEqual([
      { name: 'x', type: 4, required: true }, { name: 'y', type: 4, required: true },
      { name: 'color', type: 4, required: true },
    ]);
    for (const option of options.slice(0, 2)) {
      expect([option.min_value, option.max_value]).toEqual([-COORDINATE_LIMIT, COORDINATE_LIMIT]);
    }
    expect(options[2].choices).toEqual(PALETTE.map((hex, i) => ({ name: hex, value: i + 1 })));
    expect([options[2].min_value, options[2].max_value]).toEqual([1, 16]);
  });

  it('restricts admin and snapshot by default without restricting draw/get', () => {
    expect(commandDefinitions(false).map(({ default_member_permissions }) => default_member_permissions))
      .toEqual([null, null, '0', '0']);
  });

  it('defines every admin subcommand and uses USER rather than a numeric Discord ID', () => {
    const subcommands = commandDefinitions(false)[3].options as Subcommand[];
    expect(subcommands.map(({ name }) => name)).toEqual(['pause', 'resume', 'clear', 'ratelimit', 'size']);
    expect(subcommands[3].options).toEqual([
      { type: 6, name: 'user', description: 'Utilisateur concerné.', required: true },
      { type: 4, name: 'limit', description: 'Quota par minute (0 interdit de dessiner).', required: true,
        min_value: 0, max_value: Number.MAX_SAFE_INTEGER },
    ]);
    expect(subcommands[4].options?.map((option) => option.name)).toEqual(['width', 'height']);
    for (const option of subcommands[4].options as IntegerOption[]) {
      expect(option.required).toBe(false);
      expect([option.min_value, option.max_value]).toEqual([10_000, COORDINATE_LIMIT]);
    }
  });

  it('limits global commands to guild installations and interactions, omitting global-only fields in dev', () => {
    for (const command of commandDefinitions(true)) {
      expect(command.contexts).toEqual([0]);
      expect(command.integration_types).toEqual([0]);
    }
    for (const command of commandDefinitions(false)) {
      expect(command).not.toHaveProperty('contexts');
      expect(command).not.toHaveProperty('integration_types');
    }
  });

  it('keeps Discord names/descriptions/options/choices within API limits', () => {
    const check = (item: { name: string; description: string; options?: unknown[] }) => {
      expect(item.name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.description.length).toBeLessThanOrEqual(100);
      if (item.options) expect(item.options.length).toBeLessThanOrEqual(25);
    };
    for (const command of commandDefinitions(true)) {
      check(command);
      expect(JSON.stringify(command).length).toBeLessThan(8_000);
      for (const option of command.options ?? []) {
        check(option);
        if (option.type === 1) for (const child of option.options ?? []) check(child);
        else if (option.choices) expect(option.choices.length).toBeLessThanOrEqual(25);
      }
    }
    const first = commandDefinitions(false);
    first[0].name = 'mutated';
    expect(commandDefinitions(false)[0].name).toBe('draw');
  });
});
