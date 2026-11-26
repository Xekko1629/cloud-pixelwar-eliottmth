// Structural types: shared does not depend on the Functions Framework.
interface HealthRequest { path: string; method: string }
interface HealthResponse {
  set(field: string, value: string): HealthResponse;
  status(code: number): HealthResponse;
  json(body: unknown): unknown;
  send(): unknown;
}

/**
 * Warm-up target of the Cloud Scheduler jobs (infra/serverless/warmup.tf, ADR-0017).
 * Called by the warmer service account before any configuration check, so that a
 * misconfigured instance is still kept warm. No publication, no read, no log line.
 */
export const HEALTH_PATH = '/health';

/** Answers the health check and returns true, or returns false for any other path. */
export function answerHealth(req: HealthRequest, res: HealthResponse): boolean {
  if (req.path !== HEALTH_PATH) return false;
  if (req.method !== 'GET') res.set('Allow', 'GET').status(405).json({ error: 'method_not_allowed' });
  else res.status(204).send();
  return true;
}
