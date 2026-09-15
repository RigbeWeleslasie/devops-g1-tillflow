/**
 * OTel bootstrap — every service calls `startTelemetry()` as the first line
 * of its entrypoint, before importing anything that should be instrumented
 * (Fastify, pg). Exports OTLP to the ADOT sidecar over localhost, per
 * docs/architecture.md's "apps export OTLP to localhost:4317" contract.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

export interface TelemetryOptions {
  serviceName: string;
  /** Defaults to OTEL_EXPORTER_OTLP_ENDPOINT, then http://localhost:4317 (the sidecar). */
  otlpEndpoint?: string;
}

let sdk: NodeSDK | undefined;

export function startTelemetry(opts: TelemetryOptions): void {
  const endpoint =
    opts.otlpEndpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4317';

  sdk = new NodeSDK({
    serviceName: opts.serviceName,
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
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
