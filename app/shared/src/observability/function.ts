import { randomBytes } from 'node:crypto';
import type { createObservability } from './runtime';
import type { DrawObservation, FunctionOutcome, FunctionReason, PixelSource } from './metrics';
import type { Severity } from './logger';

type Runtime = ReturnType<typeof createObservability>;
type Carrier = { correlation_id: string; traceparent: string };
type Service = 'discord-proxy' | 'command-worker' | 'draw-worker' | 'discord-notifier';
export interface FunctionOperation {
  attributes(): Carrier;
  logFields(): Record<string, string | boolean>;
  log(severity: Severity, message: string, eventType: string): void;
  outcome(value: FunctionOutcome, reason?: FunctionReason): void;
  source(value: PixelSource): void;
  drawResult(result: DrawObservation): void;
  notificationAge(createdAt: number): void;
}
export interface FunctionTelemetry {
  request<T>(correlationId: string, work: (operation: FunctionOperation) => Promise<T>): Promise<T>;
  message<T>(name: string, attributes: Carrier, work: (operation: FunctionOperation) => Promise<T>): Promise<T>;
}
interface Options {
  getRuntime?: () => Runtime | Promise<Runtime>;
  writeLog?: (line: string) => void;
  now?: () => number;
}

/** One lazy SDK per function instance. Never logs errors/credentials or replays business work on SDK failure. */
export function createFunctionTelemetry(service: Service, options: Options = {}): FunctionTelemetry {
  const write = options.writeLog ?? ((line: string) => { process.stdout.write(line); });
  const now = options.now ?? Date.now;
  const warning = (event: string) => {
    try { write(`${JSON.stringify({ severity: 'WARNING', function: service, event_type: event })}\n`); } catch { /* Best effort only. */ }
  };
  const initialize = async (): Promise<Runtime> => {
    if (options.getRuntime) return options.getRuntime();
    const config = { serviceName: service, projectId: process.env.GOOGLE_CLOUD_PROJECT ?? '',
      environment: process.env.APP_ENV === 'prd' ? 'prd' as const : 'dev' as const,
      region: process.env.FUNCTION_REGION ?? process.env.GOOGLE_CLOUD_REGION ?? 'unknown',
      serviceVersion: process.env.K_REVISION, exportTimeoutMillis: 500, writeLog: write };
    if (process.env.NODE_ENV !== 'test' && config.projectId && ['dev', 'prd'].includes(process.env.APP_ENV ?? '')) {
      const { createGoogleObservability } = await import('./google');
      return createGoogleObservability(config);
    }
    if (process.env.NODE_ENV !== 'test' && config.projectId) warning('telemetry.export_not_configured');
    const { createObservability } = await import('./runtime');
    return createObservability(config);
  };
  let runtime: Promise<Runtime | undefined> | undefined;
  const get = () => runtime ??= initialize().catch(() => { warning('telemetry.initialization_failed'); return undefined; });

  async function run<T>(request: boolean, name: string, attributes: Carrier, work: (operation: FunctionOperation) => Promise<T>): Promise<T> {
    const obs = await get();
    const started = performance.now();
    let source: PixelSource = 'discord';
    let outcome: FunctionOutcome = 'error';
    let reason: FunctionReason = 'none';
    const safe = <V>(action: () => V, fallback: V): V => {
      try { return action(); } catch { warning('telemetry.operation_failed'); return fallback; }
    };
    const operation: FunctionOperation = {
      attributes: () => safe(() => {
        const carrier = obs?.attributes();
        return carrier ? { correlation_id: carrier.correlation_id, traceparent: carrier.traceparent } : attributes;
      }, attributes),
      logFields: () => safe(() => obs?.logFields() ?? {}, {}),
      log: (severity, message, eventType) => { safe(() => {
        if (obs) obs.log(severity, message, { event_type: eventType });
        else write(`${JSON.stringify({ severity, message, function: service, event_type: eventType, correlation_id: attributes.correlation_id })}\n`);
      }, undefined); },
      outcome: (value, code = 'none') => { outcome = value; reason = code; },
      source: (value) => { source = value; },
      drawResult: (result) => { safe(() => { obs?.functions.drawResult(result); }, undefined); },
      notificationAge: (createdAt) => { safe(() => { obs?.functions.notificationAge(Math.max(0, now() - createdAt) / 1000); }, undefined); },
    };
    let invoked = false;
    let failed = false;
    let failure: unknown;
    let value!: T;
    let pending: Promise<T> | undefined;
    const invoke = () => pending ??= (async () => {
      invoked = true;
      try { value = await work(operation); return value; }
      catch (error) { failed = true; failure = error; outcome = 'error'; throw error; }
    })();
    try {
      if (!obs) return await invoke();
      try {
        if (request) await obs.request(name, {}, invoke, attributes.correlation_id);
        else await obs.message(name, attributes, invoke);
      } catch {
        if (failed) throw failure;
        warning('telemetry.operation_failed');
        if (!invoked) await invoke();
      }
      return value;
    } finally {
      safe(() => { obs?.functions.attempt(source, outcome, reason, Math.max(0, performance.now() - started) / 1000); }, undefined);
      try { await obs?.flush(); } catch { warning('telemetry.export_failed'); }
    }
  }
  return {
    request<T>(correlationId: string, work: (operation: FunctionOperation) => Promise<T>) {
      const attributes = { correlation_id: correlationId, traceparent: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-00` };
      return run(true, 'discord.interactions.draw', attributes, work);
    },
    message: <T>(name: string, attributes: Carrier, work: (operation: FunctionOperation) => Promise<T>) => run(false, name, attributes, work),
  };
}
