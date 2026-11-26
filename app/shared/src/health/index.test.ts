import { describe, expect, it, vi } from 'vitest';
import { HEALTH_PATH, answerHealth } from './index';

function response() {
  const res = { status: vi.fn(), set: vi.fn(), send: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res); res.set.mockReturnValue(res);
  return res;
}

describe('answerHealth', () => {
  it('answers 204 without a body on GET /health', () => {
    const res = response();
    expect(answerHealth({ path: HEALTH_PATH, method: 'GET' }, res)).toBe(true);
    expect(res.status).toHaveBeenCalledWith(204); expect(res.send).toHaveBeenCalledWith();
  });
  it('refuses another method on /health', () => {
    const res = response();
    expect(answerHealth({ path: HEALTH_PATH, method: 'POST' }, res)).toBe(true);
    expect(res.set).toHaveBeenCalledWith('Allow', 'GET'); expect(res.status).toHaveBeenCalledWith(405);
  });
  it.each(['/', '/health/', '/discord/health', '/healthz'])('leaves %s to the handler', (path) => {
    const res = response();
    expect(answerHealth({ path, method: 'GET' }, res)).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
  });
});
