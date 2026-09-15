/**
 * Real SQS-backed EventSource for `devops-g1-sale-events` (infra/data.tf).
 * Long-polls (waitTimeSeconds up to 20s, matching the queue's own
 * receive_wait_time_seconds) and only deletes a message after the caller's
 * handler has committed — a crash between receive and ack redelivers,
 * which sale_paid_events (saleService.ts) is what makes safe.
 */
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import type { EventSource, SalePaidEvent } from '@tillflow/shared/events';
import { isSalePaidEvent } from '@tillflow/shared/events';

export interface SqsEventSourceOptions {
  queueUrl: string;
  region?: string;
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
}

export class SqsEventSource implements EventSource<SalePaidEvent> {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly waitTimeSeconds: number;
  private readonly visibilityTimeoutSeconds: number | undefined;
  // ReceiptHandle is what SQS actually needs to delete a message; `id`
  // (MessageId) is what's stable/loggable across a receive+ack pair.
  private readonly receiptHandles = new Map<string, string>();

  constructor(opts: SqsEventSourceOptions) {
    this.client = new SQSClient({ region: opts.region ?? process.env['AWS_REGION'] ?? 'us-east-1' });
    this.queueUrl = opts.queueUrl;
    this.waitTimeSeconds = opts.waitTimeSeconds ?? 20;
    this.visibilityTimeoutSeconds = opts.visibilityTimeoutSeconds;
  }

  async receive(maxMessages: number): Promise<Array<{ id: string; body: SalePaidEvent }>> {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: Math.min(maxMessages, 10), // SQS's own cap
        WaitTimeSeconds: this.waitTimeSeconds,
        ...(this.visibilityTimeoutSeconds !== undefined
          ? { VisibilityTimeout: this.visibilityTimeoutSeconds }
          : {}),
      }),
    );

    const out: Array<{ id: string; body: SalePaidEvent }> = [];
    for (const msg of res.Messages ?? []) {
      if (!msg.MessageId || !msg.ReceiptHandle || !msg.Body) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.Body);
      } catch {
        continue; // unparseable body -- left in the queue to hit the DLQ after maxReceiveCount
      }
      if (!isSalePaidEvent(parsed)) continue;
      this.receiptHandles.set(msg.MessageId, msg.ReceiptHandle);
      out.push({ id: msg.MessageId, body: parsed });
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
