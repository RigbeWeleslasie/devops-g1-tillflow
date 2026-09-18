/**
 * A real MeterProvider, in memory, so the SLI instruments are asserted against
 * the actual OpenTelemetry SDK rather than a hand-rolled recorder.
 *
 * Why the real SDK and not a fake meter: a fake would let the test agree with
 * itself about what `add(1, {type, result})` means while the exporter that
 * ships to CloudWatch disagrees — the fake-both-sides trap that has already
 * produced two real bugs in this repo (docs/scar-log.md). Here the instrument
 * name, the unit, the attribute keys and the aggregation are all the SDK's,
 * so a test that passes is evidence about what the sidecar will receive.
 *
 * Temporality is DELTA and `collectMetrics()` resets the exporter, so each
 * call returns *what happened since the last call*. `node --test` runs every
 * file in one process, and cumulative totals would make each test's
 * assertions depend on how many tests ran before it.
 *
 * Registering the global provider is a module-level side effect on purpose:
 * ESM evaluates this file when a test file imports it, which is before any
 * test body runs, and services/payments/src/metrics.ts builds its instruments
 * on first use. So the provider is always in place before the first `add()`.
 */
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { metrics } from '@opentelemetry/api';

const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);

const provider = new MeterProvider({
  readers: [
    new PeriodicExportingMetricReader({
      exporter,
      // Long enough that the timer never fires on its own: every collection in
      // a test is an explicit forceFlush(), so nothing races the assertions.
      exportIntervalMillis: 10 * 60_000,
      exportTimeoutMillis: 30_000,
    }),
  ],
});

metrics.setGlobalMeterProvider(provider);

/** One recorded point: its attributes and its value. */
export interface Point {
  attrs: Record<string, unknown>;
  /** Counters and gauges. */
  value: number;
  /** Histograms only. */
  count?: number;
  sum?: number;
}

/** What the exporter will put on the wire: the name, unit and help text. */
export interface Descriptor {
  name: string;
  unit: string;
  description: string;
}

export interface Snapshot {
  /** Every point recorded for an instrument, in no particular order. */
  points(name: string): Point[];
  /** The instrument's exported identity, or undefined if it recorded nothing. */
  descriptor(name: string): Descriptor | undefined;
  /** The value at exactly these attributes, or 0 if the series does not exist. */
  counter(name: string, attrs: Record<string, string>): number;
  /** The histogram series at exactly these attributes, or undefined. */
  histogram(name: string, attrs: Record<string, string>): Point | undefined;
  /** The last gauge value in this window, or undefined if nothing wrote it. */
  gauge(name: string): number | undefined;
  /** Instrument names that recorded anything in this window. */
  names(): string[];
}

function sameAttrs(a: Record<string, unknown>, want: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(want).length) return false;
  return keys.every((k) => a[k] === want[k]);
}

/**
 * Flush, read, and clear. Returns everything recorded since the previous call,
 * so a test asserts about its own window and nothing else.
 */
export async function collectMetrics(): Promise<Snapshot> {
  await provider.forceFlush();

  const byName = new Map<string, Point[]>();
  const descriptors = new Map<string, Descriptor>();
  for (const batch of exporter.getMetrics()) {
    for (const scope of batch.scopeMetrics) {
      for (const metric of scope.metrics) {
        descriptors.set(metric.descriptor.name, {
          name: metric.descriptor.name,
          unit: metric.descriptor.unit,
          description: metric.descriptor.description,
        });
        const list = byName.get(metric.descriptor.name) ?? [];
        for (const dp of metric.dataPoints) {
          const v = dp.value as number | { count: number; sum?: number };
          list.push(
            typeof v === 'number'
              ? { attrs: dp.attributes, value: v }
              : { attrs: dp.attributes, value: v.count, count: v.count, sum: v.sum ?? 0 },
          );
        }
        byName.set(metric.descriptor.name, list);
      }
    }
  }
  exporter.reset();

  return {
    names: () => [...byName.keys()].sort(),
    points: (name) => byName.get(name) ?? [],
    descriptor: (name) => descriptors.get(name),
    counter: (name, attrs) =>
      (byName.get(name) ?? [])
        .filter((p) => sameAttrs(p.attrs, attrs))
        .reduce((sum, p) => sum + p.value, 0),
    histogram: (name, attrs) => (byName.get(name) ?? []).find((p) => sameAttrs(p.attrs, attrs)),
    gauge: (name) => (byName.get(name) ?? [])[0]?.value,
  };
}

/** Throw away anything recorded so far. Use in a beforeEach. */
export async function drainMetrics(): Promise<void> {
  await collectMetrics();
}

/** Stop the reader's timer so the test process can exit. */
export async function shutdownMetrics(): Promise<void> {
  await provider.shutdown();
}
