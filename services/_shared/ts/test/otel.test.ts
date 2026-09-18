/**
 * The SLI helpers are the contract POS/Payments/Commission build their budget
 * metrics on (docs/slo-error-budgets.md), so these tests assert the two things
 * an alarm actually depends on: the instrument reaches a registered provider
 * even though it was created before one existed, and `result` arrives as a
 * dimension the budget query can group by.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { metrics } from '@opentelemetry/api';
import { sliCounter, sliHistogram } from '../src/otel.js';

/**
 * Created at module scope, before any provider is registered -- this is the
 * ordering a service hits when it declares counters at the top of a module,
 * and it is what the lazy binding in `sliCounter` exists to survive.
 */
const saleWrites = sliCounter('pos_sale_write_total', 'sale write attempts by outcome');
const callbackSeconds = sliHistogram('payments_callback_process_seconds', 'callback latency');

function collector() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    // Long interval: these tests collect explicitly rather than on a timer.
    exportIntervalMillis: 600_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  // The OTel API ignores a second setGlobalMeterProvider unless the first is
  // disabled, so each test must reset before registering its own provider.
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);
  return { reader, provider };
}

test('instruments created before provider registration still export', async () => {
  const { reader, provider } = collector();

  saleWrites.ok({ tenant: 't1' });
  callbackSeconds.record(0.42);

  const { resourceMetrics } = await reader.collect();
  const names = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics.map((m) => m.descriptor.name));

  assert.ok(names.includes('pos_sale_write_total'), `counter missing from ${names.join(', ')}`);
  assert.ok(
    names.includes('payments_callback_process_seconds'),
    `histogram missing from ${names.join(', ')}`,
  );

  metrics.disable();
  await provider.shutdown();
});

test('ok and error land as separate result dimensions', async () => {
  const { reader, provider } = collector();
  const writes = sliCounter('pos_sale_write_total_dims', 'outcome dimensions');

  writes.ok();
  writes.ok();
  writes.error('db_unique_violation');

  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics
    .flatMap((s) => s.metrics)
    .find((m) => m.descriptor.name === 'pos_sale_write_total_dims');
  assert.ok(metric, 'counter was not exported');

  const byResult = new Map(metric.dataPoints.map((d) => [d.attributes['result'], d.value]));
  assert.equal(byResult.get('ok'), 2, 'success count wrong');
  assert.equal(byResult.get('error'), 1, 'error count wrong');

  const errorPoint = metric.dataPoints.find((d) => d.attributes['result'] === 'error');
  assert.equal(errorPoint?.attributes['reason'], 'db_unique_violation');

  metrics.disable();
  await provider.shutdown();
});

test('histogram records a distribution, not a gauge', async () => {
  const { reader, provider } = collector();
  const h = sliHistogram('commission_run_duration_seconds_test', 'run duration');

  for (const v of [0.1, 0.2, 0.9]) h.record(v);

  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics
    .flatMap((s) => s.metrics)
    .find((m) => m.descriptor.name === 'commission_run_duration_seconds_test');
  assert.ok(metric, 'histogram was not exported');

  const point = metric.dataPoints[0]?.value as { count: number; sum: number };
  assert.equal(point.count, 3);
  assert.ok(Math.abs(point.sum - 1.2) < 1e-9, `sum was ${point.sum}`);

  metrics.disable();
  await provider.shutdown();
});
