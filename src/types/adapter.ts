import { JobRecord } from './job';

export interface QueueAdapter {
  readonly queueName: string;
  readonly queueType: 'bull' | 'bullmq' | 'bee';

  initialize(): void;
  wrapAddMethod(): void;
  attachEventListeners(): void;
  reEnqueueJob(jobRecord: JobRecord): Promise<void>;
  updateHeartbeat(jobId: string): Promise<void>;
  dispose(): void | Promise<void>;
}
