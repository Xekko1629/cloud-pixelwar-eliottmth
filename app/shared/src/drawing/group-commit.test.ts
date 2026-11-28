import { describe, expect, it, vi } from 'vitest';
import type { DrawCommand, DrawResult } from './command';
import { createGroupCommit } from './group-commit';

const command = (id: number): DrawCommand => ({
  event_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, occurred_at: '2026-11-19T10:00:00.000Z',
  source: 'web', author: { uid: '123', name: 'User' }, pixels: [{ x: id, y: 0, color: 1 }],
});
const result = (input: DrawCommand, tag: string) => ({ event_id: input.event_id, tag }) as unknown as DrawResult;

/** A transaction that only finishes when the test says so. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

describe('createGroupCommit', () => {
  it('starts a command alone and at once when the instance is idle', async () => {
    const one = vi.fn(async (input: DrawCommand) => result(input, 'one'));
    const group = vi.fn();
    const onGroup = vi.fn();
    // Fixed clock: with the real one, a busy machine can count 1 ms before the drain starts.
    const process = createGroupCommit(one, group, { max_group: 32, onGroup, now: () => 0 });
    const pending = process(command(1));
    expect(one).toHaveBeenCalledTimes(1); // Synchronously: no timer, no added wait.
    expect(await pending).toMatchObject({ tag: 'one' });
    expect(group).not.toHaveBeenCalled();
    expect(onGroup).toHaveBeenCalledWith({ size: 1, outcome: 'single', wait_ms: 0 });
  });

  it('groups the commands that arrive while a transaction runs, and answers each one', async () => {
    const first = gate();
    const one = vi.fn(async (input: DrawCommand) => { await first.promise; return result(input, 'one'); });
    const group = vi.fn(async (inputs: readonly DrawCommand[]) => inputs.map((input) => result(input, 'group')));
    const onGroup = vi.fn();
    const process = createGroupCommit(one, group, { max_group: 32, onGroup });
    const answers = [1, 2, 3, 4].map((id) => process(command(id)));
    first.open();
    const results = await Promise.all(answers);
    expect(results.map((r) => [r.event_id, (r as unknown as { tag: string }).tag])).toEqual([
      [command(1).event_id, 'one'], [command(2).event_id, 'group'], [command(3).event_id, 'group'], [command(4).event_id, 'group'],
    ]);
    expect(group).toHaveBeenCalledExactlyOnceWith([command(2), command(3), command(4)]);
    expect(onGroup.mock.calls.map(([{ size, outcome }]) => ({ size, outcome }))).toEqual([{ size: 1, outcome: 'single' }, { size: 3, outcome: 'committed' }]);
  });

  it('reports how long the oldest command of a group waited for the previous transaction', async () => {
    const first = gate();
    let clock = 1000;
    const one = vi.fn(async (input: DrawCommand) => { await first.promise; return result(input, 'one'); });
    const group = vi.fn(async (inputs: readonly DrawCommand[]) => inputs.map((input) => result(input, 'group')));
    const onGroup = vi.fn();
    const process = createGroupCommit(one, group, { max_group: 32, onGroup, now: () => clock });
    const answers = [process(command(1)), process(command(2))];
    clock = 1250; answers.push(process(command(3)));
    clock = 1800; first.open();
    await Promise.all(answers);
    expect(onGroup.mock.calls.map(([event]) => event)).toEqual([
      { size: 1, outcome: 'single', wait_ms: 0 }, { size: 2, outcome: 'committed', wait_ms: 800 },
    ]);
  });

  it('never sends more than max_group commands in one transaction', async () => {
    const first = gate();
    const one = vi.fn(async (input: DrawCommand) => { await first.promise; return result(input, 'one'); });
    const group = vi.fn(async (inputs: readonly DrawCommand[]) => inputs.map((input) => result(input, 'group')));
    const process = createGroupCommit(one, group, { max_group: 2 });
    const answers = [1, 2, 3, 4, 5, 6].map((id) => process(command(id)));
    first.open();
    await Promise.all(answers);
    // 1 alone, then [2, 3], [4, 5], and 6 alone again.
    expect(group.mock.calls.map(([inputs]) => inputs.length)).toEqual([2, 2]);
    expect(one).toHaveBeenCalledTimes(2);
  });

  it('processes each command alone when its group fails: only the faulty one is refused', async () => {
    const first = gate();
    const faulty = command(3);
    const one = vi.fn(async (input: DrawCommand) => {
      if (input.event_id === command(1).event_id) await first.promise;
      if (input.event_id === faulty.event_id) throw new Error('corrupt tile');
      return result(input, 'one');
    });
    const group = vi.fn(async () => { throw new Error('group aborted'); });
    const onGroup = vi.fn();
    const process = createGroupCommit(one, group, { max_group: 32, onGroup });
    const answers = [1, 2, 3, 4].map((id) => process(command(id)).then((r) => r.event_id, (error: Error) => error.message));
    first.open();
    expect(await Promise.all(answers)).toEqual([command(1).event_id, command(2).event_id, 'corrupt tile', command(4).event_id]);
    expect(onGroup).toHaveBeenCalledWith(expect.objectContaining({ size: 3, outcome: 'fallback' }));
    // The fallback runs one command after the other, never two at the same time.
    expect(one.mock.calls.map(([input]) => input.event_id)).toEqual([1, 2, 3, 4].map((id) => command(id).event_id));
  });

  it('splits a contended group once, then fails each contended half at once, never one by one', async () => {
    const first = gate();
    const one = vi.fn(async (input: DrawCommand) => { if (input.event_id === command(1).event_id) await first.promise; return result(input, 'one'); });
    const aborted = Object.assign(new Error('10 ABORTED'), { code: 10 });
    const group = vi.fn(async (_inputs: readonly DrawCommand[]): Promise<DrawResult[]> => { throw aborted; });
    const onGroup = vi.fn();
    const process = createGroupCommit(one, group, { max_group: 32, onGroup });
    const answers = [1, 2, 3, 4, 5].map((id) => process(command(id)).then((r) => r.event_id, (error: unknown) => error));
    first.open();
    expect(await Promise.all(answers)).toEqual([command(1).event_id, aborted, aborted, aborted, aborted]);
    expect(one).toHaveBeenCalledTimes(1); // Only the first command, alone; never the 4 of the group.
    expect(group.mock.calls.map(([inputs]) => inputs.length)).toEqual([4, 2, 2]); // Halves once, not quarters.
    expect(onGroup.mock.calls.slice(1).map(([event]) => [event.size, event.outcome]))
      .toEqual([[4, 'split'], [2, 'contention'], [2, 'contention']]);
    // The instance is free again at once: the next command is processed.
    expect(await process(command(5))).toMatchObject({ tag: 'one' });
  });

  it('lets the caller decide what contention is', async () => {
    const first = gate();
    const one = vi.fn(async (input: DrawCommand) => { if (input.event_id === command(1).event_id) await first.promise; return result(input, 'one'); });
    const process = createGroupCommit(one, vi.fn(async () => { throw new Error('custom'); }), { max_group: 32, isContention: () => true });
    const answers = [1, 2, 3, 4, 5].map((id) => process(command(id)).then(() => 'ok', () => 'refused'));
    first.open();
    expect(await Promise.all(answers)).toEqual(['ok', 'refused', 'refused', 'refused', 'refused']);
  });

  it('commits the half that no longer collides and refuses only the other one', async () => {
    const first = gate();
    const one = vi.fn(async (input: DrawCommand) => { if (input.event_id === command(1).event_id) await first.promise; return result(input, 'one'); });
    const aborted = Object.assign(new Error('10 ABORTED'), { code: 10 });
    // Contention whenever command 5 is in the transaction: the whole group, then its half.
    const group = vi.fn(async (inputs: readonly DrawCommand[]) => {
      if (inputs.some((input) => input.event_id === command(5).event_id)) throw aborted;
      return inputs.map((input) => result(input, 'group'));
    });
    const onGroup = vi.fn();
    const process = createGroupCommit(one, group, { max_group: 32, onGroup });
    const answers = [1, 2, 3, 4, 5].map((id) => process(command(id)).then((r) => (r as unknown as { tag: string }).tag, () => 'refused'));
    first.open();
    expect(await Promise.all(answers)).toEqual(['one', 'group', 'group', 'refused', 'refused']);
    expect(onGroup.mock.calls.slice(1).map(([event]) => [event.size, event.outcome]))
      .toEqual([[4, 'split'], [2, 'committed'], [2, 'contention']]);
  });

  it('sends a half of one command alone', async () => {
    const first = gate();
    const one = vi.fn(async (input: DrawCommand) => { if (input.event_id === command(1).event_id) await first.promise; return result(input, 'one'); });
    const group = vi.fn(async () => { throw Object.assign(new Error('10 ABORTED'), { code: 10 }); });
    const onGroup = vi.fn();
    const process = createGroupCommit(one, group, { max_group: 32, onGroup });
    const answers = [1, 2, 3, 4].map((id) => process(command(id)).then((r) => (r as unknown as { tag: string }).tag, () => 'refused'));
    first.open();
    expect(await Promise.all(answers)).toEqual(['one', 'refused', 'refused', 'one']);
    expect(onGroup.mock.calls.slice(1).map(([event]) => [event.size, event.outcome]))
      .toEqual([[3, 'split'], [2, 'contention'], [1, 'single']]);
  });

  it('falls back when a group returns a wrong number of results', async () => {
    const first = gate();
    const one = vi.fn(async (input: DrawCommand) => { if (input.event_id === command(1).event_id) await first.promise; return result(input, 'one'); });
    const group = vi.fn(async () => []);
    const process = createGroupCommit(one, group, { max_group: 32 });
    const answers = [1, 2, 3].map((id) => process(command(id)));
    first.open();
    expect((await Promise.all(answers)).every((r) => (r as unknown as { tag: string }).tag === 'one')).toBe(true);
    expect(group).toHaveBeenCalledTimes(1);
  });

  it('keeps working after a failed command and when the observer throws', async () => {
    const one = vi.fn().mockRejectedValueOnce(new Error('boom')).mockImplementation(async (input: DrawCommand) => result(input, 'one'));
    const process = createGroupCommit(one, vi.fn(), { max_group: 32, onGroup: () => { throw new Error('observer'); } });
    await expect(process(command(1))).rejects.toThrow('boom');
    expect(await process(command(2))).toMatchObject({ tag: 'one' });
  });

  it.each([0, 1.5, Number.NaN])('refuses max_group %s', (value) => {
    expect(() => createGroupCommit(vi.fn(), vi.fn(), { max_group: value })).toThrow('max_group');
  });
});
