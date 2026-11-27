import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTransient } from './PixelPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Renders the hook and exposes what it returns.
function render(text: string | null, ms: number | null, source: object) {
  const seen: Array<string | null> = [];
  function Probe(props: { text: string | null; ms: number | null; source: object }) {
    seen.push(useTransient(props.text, props.ms, props.source));
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe, { text, ms, source })));
  return {
    last: () => seen.at(-1),
    update: (next: { text: string | null; ms: number | null; source: object }) => act(() => root.render(createElement(Probe, next))),
    unmount: () => act(() => root.unmount()),
  };
}

describe('useTransient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hides the message of an ended action after its delay', () => {
    const view = render('Pixel posé.', 4000, {});
    expect(view.last()).toBe('Pixel posé.');
    act(() => vi.advanceTimersByTime(4000));
    expect(view.last()).toBeNull();
    view.unmount();
  });

  it('keeps the message of a running action', () => {
    const view = render('Envoi…', null, {});
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.last()).toBe('Envoi…');
    view.unmount();
  });

  it('shows the same text again for a new action', () => {
    const view = render('Pixel posé.', 4000, {});
    act(() => vi.advanceTimersByTime(4000));
    view.update({ text: 'Pixel posé.', ms: 4000, source: {} });
    expect(view.last()).toBe('Pixel posé.');
    view.unmount();
  });
});
