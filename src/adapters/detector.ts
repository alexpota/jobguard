import { QueueAdapter } from '../types/adapter';
import { JobRepository } from '../persistence/repository';
import { Logger } from '../utils/logger';
import { UnsupportedQueueError } from '../errors/errors';
import { AnyQueue, isBullQueue, isBullMQQueue, isBeeQueue } from '../types/queue-types';

export class QueueDetector {
  detectQueueType(queue: AnyQueue): 'bull' | 'bullmq' | 'bee' | 'unknown' {
    // Use type guards for detection
    if (isBullMQQueue(queue)) {
      return 'bullmq';
    }

    if (isBullQueue(queue)) {
      return 'bull';
    }

    if (isBeeQueue(queue)) {
      return 'bee';
    }

    return 'unknown';
  }

  createAdapter(
    queue: AnyQueue,
    repository: JobRepository,
    logger: Logger
  ): QueueAdapter {
    const type = this.detectQueueType(queue);

    switch (type) {
      case 'bull': {
        // Lazy load to avoid requiring all dependencies
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { BullAdapter } = require('./bull.adapter');
        return new BullAdapter(queue, repository, logger) as QueueAdapter;
      }
      case 'bullmq': {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { BullMQAdapter } = require('./bullmq.adapter');
        return new BullMQAdapter(queue, repository, logger) as QueueAdapter;
      }
      case 'bee': {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { BeeAdapter } = require('./bee.adapter');
        return new BeeAdapter(queue, repository, logger) as QueueAdapter;
      }
      default:
        throw new UnsupportedQueueError(type);
    }
  }
}
