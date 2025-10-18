import { BaseAdapter } from './base.adapter';
import { JobRecord, JobStatus } from '../types/job';
import { JobRepository } from '../persistence/repository';
import { Logger } from '../utils/logger';
import { BeeQueue, BeeJob } from '../types/queue-types';

export class BeeAdapter extends BaseAdapter {
  declare protected queue: BeeQueue;
  readonly queueType = 'bee' as const;
  private eventHandlers: Map<string, Function> = new Map();

  constructor(queue: BeeQueue, repository: JobRepository, logger: Logger) {
    super(queue, repository, logger);
    this.queue = queue;
  }

  get queueName(): string {
    // Bee-Queue has a name property, use it instead of redis.db
    if (this.queue.name) {
      return this.queue.name;
    }

    // Fallback with warning - this should never happen in practice
    const fallback = `bee-queue-${this.queue.settings?.redis?.db || 'default'}`;
    this.logger.warn(
      `Bee-Queue instance has no name property. Using fallback: ${fallback}. ` +
        `This may cause queue collisions. Please create queue with explicit name.`
    );
    return fallback;
  }

  wrapAddMethod(): void {
    // Bee-Queue uses createJob() instead of add()
    const originalCreateJob = this.queue.createJob.bind(this.queue);

    this.queue.createJob = (data: unknown): BeeJob => {
      const job = originalCreateJob(data);

      // Wrap the save method
      const originalSave = job.save.bind(job);
      job.save = async (): Promise<unknown> => {
        const result = await originalSave();

        // Persist to PostgreSQL after successful save
        await this.handleJobCreated(
          this.getJobIdAsString(job.id),
          undefined, // Bee-Queue doesn't have job names
          data
        );

        return result;
      };

      return job;
    };

    this.logger.debug(`Wrapped createJob method for Bee queue: ${this.queueName}`);
  }

  attachEventListeners(): void {
    // Job progress event (similar to active)
    const progressHandler = (job: BeeJob) => {
      void this.handleJobStarted(this.getJobIdAsString(job.id));
    };

    // Succeeded event
    const succeededHandler = (job: BeeJob) => {
      void this.handleJobCompleted(this.getJobIdAsString(job.id));
    };

    // Failed event
    const failedHandler = (job: BeeJob, err: Error) => {
      void this.handleJobFailed(this.getJobIdAsString(job.id), err);
    };

    // Store handlers for cleanup
    this.eventHandlers.set('job progress', progressHandler);
    this.eventHandlers.set('job succeeded', succeededHandler);
    this.eventHandlers.set('job failed', failedHandler);

    // Attach to queue
    this.queue.on('job progress', progressHandler);
    this.queue.on('job succeeded', succeededHandler);
    this.queue.on('job failed', failedHandler);

    this.logger.debug(`Attached event listeners for Bee queue: ${this.queueName}`);
  }

  async reEnqueueJob(jobRecord: JobRecord): Promise<void> {
    try {
      this.logger.info(`Re-enqueueing stuck job: ${jobRecord.job_id}`);

      // Re-verify job status from PostgreSQL to prevent race conditions
      // Job could have completed between marking as stuck and now
      const currentJob = await this.repository.getJob(
        this.queueName,
        this.queueType,
        jobRecord.job_id
      );

      if (!currentJob || currentJob.status !== 'stuck') {
        this.logger.info(
          `Job ${jobRecord.job_id} status changed (${currentJob?.status || 'not found'}), ` +
            `skipping re-enqueue`
        );
        return;
      }

      // Bee-Queue doesn't support jobId parameter, so we can't prevent duplicates
      // the same way. Instead, we mark the old job as failed to prevent double-processing
      // from PostgreSQL perspective.

      // Create new job with original data
      const job = this.queue.createJob(jobRecord.data);
      await job.save();

      // Mark old job as failed in PostgreSQL (new job gets new ID)
      // This is correct for Bee-Queue since it generates new IDs
      await this.repository.updateJobStatus(
        this.queueName,
        this.queueType,
        jobRecord.job_id,
        JobStatus.FAILED
      );

      this.logger.info(
        `Successfully re-enqueued job: ${jobRecord.job_id} as new job ${job.id}`
      );
    } catch (error) {
      this.logger.error(`Failed to re-enqueue job ${jobRecord.job_id}:`, error);
      throw error;
    }
  }

  dispose(): void {
    // Remove event listeners
    for (const [event, handler] of this.eventHandlers.entries()) {
      this.queue.removeListener(event, handler);
    }
    this.eventHandlers.clear();

    super.dispose();
  }
}
