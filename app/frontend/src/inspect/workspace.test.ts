import { describe, expect, it } from 'vitest';
import { readPreviewSetting, writePreviewSetting } from './Workspace';

describe('preview setting', () => {
  it('is on unless turned off, and remembers the choice', () => {
    const values = new Map<string, string>();
    const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) });
    expect(readPreviewSetting(storage)).toBe(true);
    writePreviewSetting(false, storage);
    expect(readPreviewSetting(storage)).toBe(false);
    writePreviewSetting(true, storage);
    expect(readPreviewSetting(storage)).toBe(true);
  });

  it('stays on when the storage is blocked', () => {
    const blocked = () => { throw new Error('SecurityError'); };
    expect(readPreviewSetting(blocked)).toBe(true);
    expect(() => writePreviewSetting(false, blocked)).not.toThrow();
  });
});
