/**
 * Real SQS publisher for the outbox relay. Sends sale.paid to
 * `devops-g1-sale-events`, which POS consumes (infra/data.tf: payments is
 * the only producer, pos the only consumer).
 *
 * MessageGroupId/DeduplicationId are deliberately absent — the queue is a
 * standard queue, not FIFO. Ordering is not required (POS's consumer is
 * idempotent on saleId and order-independent by design), and a standard
 * queue gives us far higher throughput for the k6 envelope.
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SalePaidEvent } from '@tillflow/shared/events';
import type { EventPublisher } from './outbox.js';

export interface SqsPublisherOptions {
  queueUrl: string;
  region?: string;
}

export class SqsEventPublisher implements EventPublisher {
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  constructor(opts: SqsPublisherOptions) {
    this.client = new SQSClient({ region: opts.region ?? process.env['AWS_REGION'] ?? 'us-east-1' });
    this.queueUrl = opts.queueUrl;
  }

  async publish(event: SalePaidEvent): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(event),
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: event.eventType },
          saleId: { DataType: 'String', StringValue: event.data.saleId },
        },
      }),
    );
  }
}

/**
 * Used when SALE_EVENTS_QUEUE_URL is unset (local dev, tests). Events stay
 * in the outbox table and are visible there; nothing is silently dropped,
 * and the relay reports them as failed so the backlog is obvious.
 */
export class UnconfiguredPublisher implements EventPublisher {
  async publish(): Promise<void> {
    throw new Error('SALE_EVENTS_QUEUE_URL is not set; sale.paid stays in the outbox');
  }
}
