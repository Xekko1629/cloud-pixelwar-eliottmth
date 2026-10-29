import { expect, it } from 'vitest';

// Infrastructure smoke test only: frontend behavior will be tested with its implementation.
it('provides a browser-like DOM for future frontend unit tests', () => {
  const canvas = document.createElement('canvas');
  expect(canvas).toBeInstanceOf(HTMLCanvasElement);
});
