/**
 * In-process EventSource — same interface as the real SQS-backed one, used
 * in tests and local dev so the consumer's logic (including replay/reorder
 * drills) can run with no AWS dependency at all.
 */
import { randomUUID } from 'node:crypto';
import type { EventSource, SalePaidEvent } from '@tillflow/shared/events';

export class FakeEventSource implements EventSource<SalePaidEvent> {
  private queue: Array<{ id: string; body: SalePaidEvent }> = [];
  private readonly acked = new Set<string>();

  /** Enqueue a message. `id` defaults to a fresh one — pass the SAME id twice to simulate a redelivery of the identical message. */
  publish(body: SalePaidEvent, id: string = randomUUID()): void {
    this.queue.push({ id, body });
  }

  async receive(maxMessages: number): Promise<Array<{ id: string; body: SalePaidEvent }>> {
    const batch = this.queue.splice(0, maxMessages);
    return Promise.resolve(batch);
  }

  async ack(id: string): Promise<void> {
    this.acked.add(id);
    return Promise.resolve();
  }

  wasAcked(id: string): boolean {
    return this.acked.has(id);
  }
}
