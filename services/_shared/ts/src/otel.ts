/**
 * OTel bootstrap — every service calls `startTelemetry()` as the first line
 * of its entrypoint, before importing anything that should be instrumented
 * (Fastify, pg). Exports OTLP to the ADOT sidecar over localhost, per
 * docs/architecture.md's "apps export OTLP to localhost:4317" contract.
 *
 * Traces go to X-Ray and metrics to CloudWatch (namespace `TillFlow`), both
 * via the sidecar's two pipelines (infra/ecs.tf). `service.name` becomes a
 * CloudWatch dimension, which is how per-service SLO panels and alarms
 * separate the four services inside the one namespace.
 *
 * Metric naming is owned by docs/slo-error-budgets.md (DRI: Rigbe) — the
 * `Sli` helpers below exist so a service adds an SLI counter in one line
 * rather than bootstrapping its own meter.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { metrics, type Attributes, type Counter, type Histogram } from '@opentelemetry/api';

export interface TelemetryOptions {
  serviceName: string;
  /** Defaults to OTEL_EXPORTER_OTLP_ENDPOINT, then http://localhost:4317 (the sidecar). */
  otlpEndpoint?: string;
  /**
   * Metric export interval. Defaults to 15s, which is below CloudWatch's
   * 60s alarm period so a 1-minute datapoint is never assembled from a
   * single sample. Tests pass a large value to keep the timer quiet.
   */
  metricIntervalMillis?: number;
}

let sdk: NodeSDK | undefined;

export function startTelemetry(opts: TelemetryOptions): void {
  const endpoint =
    opts.otlpEndpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4317';

  sdk = new NodeSDK({
    serviceName: opts.serviceName,
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    // `metricReaders` (plural), not the deprecated singular `metricReader`.
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: endpoint }),
        exportIntervalMillis: opts.metricIntervalMillis ?? 15_000,
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        // The fs instrumentation is extremely noisy and rarely useful for an
        // HTTP service; every other default instrumentation (http, pg, etc.)
        // stays on.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void sdk?.shutdown().finally(() => process.exit(0));
    });
  }
}

/** Flush and stop telemetry. Exposed for tests and for worker shutdown paths. */
export async function stopTelemetry(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

/**
 * The meter every service shares. Safe to call before `startTelemetry()`:
 * the API returns a no-op meter until the SDK registers a real provider, so
 * module-level instrument creation never depends on import order.
 */
export function getMeter(name = '@tillflow/shared') {
  return metrics.getMeter(name);
}

/**
 * An SLI counter, per docs/slo-error-budgets.md. Records one event and its
 * outcome; `result` is the dimension the budget query groups by, so it must
 * stay low-cardinality (`ok` / `error` / a short reason, never an id).
 */
export interface SliCounter {
  ok(attrs?: Attributes): void;
  error(reason: string, attrs?: Attributes): void;
  add(value: number, attrs?: Attributes): void;
}

export function sliCounter(name: string, description: string): SliCounter {
  // Resolved per call, not cached. Instruments are usually declared at module
  // scope -- before `startTelemetry()` registers a provider -- so caching the
  // first result would pin the counter to the no-op provider that was active
  // at import time, and nothing would ever be exported. Resolution is a map
  // lookup in the SDK, so per-call is cheap enough for a request-path counter.
  const counter = (): Counter => getMeter().createCounter(name, { description });

  return {
    ok: (attrs) => counter().add(1, { result: 'ok', ...attrs }),
    error: (reason, attrs) => counter().add(1, { result: 'error', reason, ...attrs }),
    add: (value, attrs) => counter().add(value, attrs),
  };
}

/**
 * A latency histogram in seconds, matching the SLO doc's `*_seconds` names.
 * Returns an object rather than a real `Histogram` so resolution stays lazy
 * for the same reason as `sliCounter`.
 */
export interface SliHistogram {
  record(value: number, attrs?: Attributes): void;
}

export function sliHistogram(name: string, description: string): SliHistogram {
  const get = (): Histogram => getMeter().createHistogram(name, { description, unit: 's' });
  return {
    record: (value, attrs) => get().record(value, attrs),
  };
}
