import { BaseAdapter } from './base.adapter';
import { JobRecord, JobStatus } from '../types/job';
import { JobRepository } from '../persistence/repository';
import { Logger } from '../utils/logger';
import { BullQueue, BullJob } from '../types/queue-types';

export class BullAdapter extends BaseAdapter {
  declare protected queue: BullQueue;
  readonly queueType = 'bull' as const;
  private eventHandlers: Map<string, (...args: any[]) => void> = new Map();
  declare protected originalAdd?: BullQueue['add'];

  constructor(queue: BullQueue, repository: JobRepository, logger: Logger) {
    super(queue, repository, logger);
    this.queue = queue;
  }

  get queueName(): string {
    return this.queue.name;
  }

  wrapAddMethod(): void {
    this.originalAdd = this.queue.add.bind(this.queue) as BullQueue['add'];

    this.queue.add = async (
      nameOrData: string | unknown,
      dataOrOpts?: unknown,
      opts?: { attempts?: number; jobId?: string; [key: string]: unknown }
    ): Promise<BullJob> => {
      let jobName: string | undefined;
      let jobData: unknown;
      let jobOpts:
        | { attempts?: number; jobId?: string; [key: string]: unknown }
        | undefined;

      // Handle Bull's flexible add() signature
      // add(data, opts) or add(name, data, opts)
      if (typeof nameOrData === 'string') {
        jobName = nameOrData;
        jobData = dataOrOpts;
        jobOpts = opts;
      } else {
        jobData = nameOrData;
        jobOpts = dataOrOpts as
          | { attempts?: number; jobId?: string; [key: string]: unknown }
          | undefined;
      }

      // Call original add method (type assertion since overloading is complex)
      if (!this.originalAdd) {
        throw new Error('Original add method not found');
      }
      const job = await (this.originalAdd as any)(nameOrData, dataOrOpts, opts); // eslint-disable-line @typescript-eslint/no-explicit-any

      // Extract max attempts from options (Bull uses 'attempts' field)
      const maxAttempts = jobOpts?.attempts;

      // Persist to PostgreSQL
      await this.handleJobCreated(
        this.getJobIdAsString(job.id),
        jobName,
        jobData,
        maxAttempts
      );

      return job;
    };

    this.logger.debug(`Wrapped add method for Bull queue: ${this.queueName}`);
  }

  attachEventListeners(): void {
    // Active event - when job starts processing
    const activeHandler = (job: BullJob) => {
      void this.handleJobStarted(this.getJobIdAsString(job.id));
    };

    // Completed event
    const completedHandler = (job: BullJob) => {
      void this.handleJobCompleted(this.getJobIdAsString(job.id));
    };

    // Failed event
    const failedHandler = (job: BullJob, err: Error) => {
      void this.handleJobFailed(this.getJobIdAsString(job.id), err);
    };

    // Store handlers for cleanup
    this.eventHandlers.set('active', activeHandler);
    this.eventHandlers.set('completed', completedHandler);
    this.eventHandlers.set('failed', failedHandler);

    // Attach to queue
    this.queue.on('active', activeHandler);
    this.queue.on('completed', completedHandler);
    this.queue.on('failed', failedHandler);

    this.logger.debug(`Attached event listeners for Bull queue: ${this.queueName}`);
  }

  /**
   * Atomically check if job is processed and remove it from Redis
   * Uses Lua script to prevent race conditions
   */
  private async atomicRemoveJob(jobId: string): Promise<boolean> {
    const client = this.queue.client as any; // Redis client doesn't have full types
    const jobKey = `bull:${this.queueName}:${jobId}`;

    // Lua script for atomic check-and-remove with error handling
    const script = `
      local jobKey = KEYS[1]
      local queueName = ARGV[1]
      local jobId = ARGV[2]

      local success, jobData = pcall(redis.call, 'HGETALL', jobKey)
      if not success then
        return -1  -- Error occurred
      end

      -- If job doesn't exist, return 0 (already removed)
      if #jobData == 0 then
        return 0
      end

      -- Parse job data to check if processed
      -- Support both 'finishedOn'/'processedOn' field name variations
      local finishedOn = nil
      local processedOn = nil
      local failedReason = nil

      for i = 1, #jobData, 2 do
        local fieldName = jobData[i]
        if fieldName == 'finishedOn' or fieldName == 'finished' then
          finishedOn = jobData[i + 1]
        elseif fieldName == 'processedOn' or fieldName == 'processed' then
          processedOn = jobData[i + 1]
        elseif fieldName == 'failedReason' or fieldName == 'failed' then
          failedReason = jobData[i + 1]
        end
      end

      -- If job is completed or failed, don't remove (already processed)
      if finishedOn or failedReason then
        return 0
      end

      -- Job exists and is not processed - safe to remove
      local ok = pcall(redis.call, 'DEL', jobKey)
      if not ok then
        return -1  -- Failed to delete job
      end

      -- Also remove from any sets it might be in (use pcall to prevent partial failures)
      local prefix = 'bull:' .. queueName
      pcall(redis.call, 'ZREM', prefix .. ':delayed', jobId)
      pcall(redis.call, 'ZREM', prefix .. ':waiting', jobId)
      pcall(redis.call, 'LREM', prefix .. ':wait', 0, jobId)
      pcall(redis.call, 'LREM', prefix .. ':active', 0, jobId)
      pcall(redis.call, 'LREM', prefix .. ':paused', 0, jobId)

      return 1
    `;

    try {
      const result = await client.eval(script, 1, jobKey, this.queueName, jobId);
      return result === 1;
    } catch (error) {
      this.logger.warn(
        `Lua script failed for job ${jobId}, falling back to non-atomic:`,
        error
      );
      // Fallback to non-atomic removal
      try {
        const job = await this.queue.getJob(jobId);
        if (job) {
          const state = await job.getState();
          if (state !== 'completed' && state !== 'failed') {
            await job.remove();
            return true;
          }
        }
      } catch (fallbackError) {
        // Job doesn't exist, which is fine
      }
      return false;
    }
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

      // Atomically check and remove job from Redis if not processed
      const removed = await this.atomicRemoveJob(jobRecord.job_id);

      if (!removed) {
        this.logger.info(
          `Job ${jobRecord.job_id} already processed or doesn't exist, skipping re-enqueue`
        );
        return;
      }

      // Safe to re-enqueue now - job was removed atomically
      if (!this.originalAdd) {
        throw new Error('Original add method not found');
      }

      // Call with job name if present, otherwise just data
      if (jobRecord.job_name) {
        await (this.originalAdd as any)(jobRecord.job_name, jobRecord.data, {
          // eslint-disable-line @typescript-eslint/no-explicit-any
          jobId: jobRecord.job_id,
          attempts: jobRecord.attempts + 1,
        });
      } else {
        await (this.originalAdd as any)(jobRecord.data, {
          // eslint-disable-line @typescript-eslint/no-explicit-any
          jobId: jobRecord.job_id,
          attempts: jobRecord.attempts + 1,
        });
      }

      // Update status to pending
      await this.repository.updateJobStatus(
        this.queueName,
        this.queueType,
        jobRecord.job_id,
        JobStatus.PENDING
      );

      this.logger.info(`Successfully re-enqueued job: ${jobRecord.job_id}`);
    } catch (error) {
      this.logger.error(`Failed to re-enqueue job ${jobRecord.job_id}:`, error);
      throw error;
    }
  }

  dispose(): void {
    // Remove event listeners
    // Convert Map.entries() to array for TypeScript compatibility
    const handlers = Array.from(this.eventHandlers.entries());
    for (const [event, handler] of handlers) {
      this.queue.removeListener(event, handler);
    }
    this.eventHandlers.clear();

    super.dispose();
  }
}
