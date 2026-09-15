/**
 * Real SQS-backed TriggerSource for devops-g1-commission-payout.
 *
 * Long-polls, and deletes a message only when the caller acks — which
 * closeWorker does after the close commits. A crash in between redelivers
 * the trigger, which runClose absorbs (I4).
 *
 * Messages are parsed leniently on purpose: EventBridge Scheduler delivers
 * the raw `input` JSON, but a hand-posted drill message may be a bare
 * string. Anything unparseable is surfaced as `{}` so businessDayFor falls
 * back to "the day that just ended" rather than the worker crashing on a
 * malformed trigger.
 */
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import type { TriggerMessage, TriggerSource } from './closeWorker.js';

export interface SqsTriggerSourceOptions {
  queueUrl: string;
  region?: string;
  waitTimeSeconds?: number;
  /** Long enough for a whole close to finish before redelivery. */
  visibilityTimeoutSeconds?: number;
}

export class SqsTriggerSource implements TriggerSource {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly waitTimeSeconds: number;
  private readonly visibilityTimeoutSeconds: number | undefined;
  private readonly receiptHandles = new Map<string, string>();

  constructor(opts: SqsTriggerSourceOptions) {
    this.client = new SQSClient({ region: opts.region ?? process.env['AWS_REGION'] ?? 'us-east-1' });
    this.queueUrl = opts.queueUrl;
    this.waitTimeSeconds = opts.waitTimeSeconds ?? 20;
    this.visibilityTimeoutSeconds = opts.visibilityTimeoutSeconds;
  }

  async receive(maxMessages: number): Promise<TriggerMessage[]> {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: Math.min(maxMessages, 10),
        WaitTimeSeconds: this.waitTimeSeconds,
        ...(this.visibilityTimeoutSeconds !== undefined
          ? { VisibilityTimeout: this.visibilityTimeoutSeconds }
          : {}),
      }),
    );

    const out: TriggerMessage[] = [];
    for (const msg of res.Messages ?? []) {
      if (!msg.MessageId || !msg.ReceiptHandle) continue;
      let body: unknown = {};
      try {
        body = msg.Body ? JSON.parse(msg.Body) : {};
      } catch {
        body = {};
      }
      this.receiptHandles.set(msg.MessageId, msg.ReceiptHandle);
      out.push({ id: msg.MessageId, body });
    }
    return out;
  }

  async ack(id: string): Promise<void> {
    const receiptHandle = this.receiptHandles.get(id);
    if (!receiptHandle) return;
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }),
    );
    this.receiptHandles.delete(id);
  }
}

/** In-process TriggerSource for local dev and tests. */
export class FakeTriggerSource implements TriggerSource {
  private queue: TriggerMessage[] = [];
  readonly acked = new Set<string>();

  publish(body: unknown, id = `msg-${this.queue.length + 1}`): void {
    this.queue.push({ id, body });
  }

  async receive(maxMessages: number): Promise<TriggerMessage[]> {
    return Promise.resolve(this.queue.splice(0, maxMessages));
  }

  async ack(id: string): Promise<void> {
    this.acked.add(id);
    return Promise.resolve();
  }
}
