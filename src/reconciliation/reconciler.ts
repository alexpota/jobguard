import { JobRepository } from '../persistence/repository';
import { QueueAdapter } from '../types/adapter';
import { ReconciliationConfig } from '../types/config';
import { Logger } from '../utils/logger';
import { AdaptiveScheduler } from './scheduler';
import { ReconciliationError } from '../errors/errors';

export class Reconciler {
  private repository: JobRepository;
  private adapter: QueueAdapter;
  private config: Required<ReconciliationConfig>;
  private logger: Logger;
  private scheduler: AdaptiveScheduler;
  private intervalHandle?: NodeJS.Timeout;
  private isRunning = false;
  private isStopped = false;
  private consecutiveFailures = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 3;

  constructor(
    repository: JobRepository,
    adapter: QueueAdapter,
    config: ReconciliationConfig,
    logger: Logger
  ) {
    this.repository = repository;
    this.adapter = adapter;
    this.logger = logger;

    // Apply defaults
    const stuckThresholdMs = config.stuckThresholdMs || 300000;

    // Validate stuckThresholdMs is reasonable (minimum 60 seconds)
    const MIN_STUCK_THRESHOLD = 60000; // 60 seconds
    if (stuckThresholdMs < MIN_STUCK_THRESHOLD) {
      throw new ReconciliationError(
        `stuckThresholdMs must be at least ${MIN_STUCK_THRESHOLD}ms (60 seconds), ` +
          `got ${stuckThresholdMs}ms. This prevents marking healthy jobs as stuck.`
      );
    }

    this.config = {
      enabled: config.enabled !== false,
      intervalMs: config.intervalMs || 30000,
      stuckThresholdMs,
      batchSize: config.batchSize || 100,
      adaptiveScheduling: config.adaptiveScheduling !== false,
      rateLimitPerSecond: config.rateLimitPerSecond || 20,
      useHeartbeat: config.useHeartbeat !== false,
    };

    this.scheduler = new AdaptiveScheduler(
      {
        baseIntervalMs: this.config.intervalMs,
        adaptiveScheduling: this.config.adaptiveScheduling,
      },
      logger
    );
  }

  start(): void {
    if (!this.config.enabled) {
      this.logger.info('Reconciliation is disabled');
      return;
    }

    if (this.intervalHandle) {
      this.logger.warn('Reconciliation is already running');
      return;
    }

    this.logger.info(
      `Starting reconciliation with interval: ${this.config.intervalMs}ms, ` +
        `stuck threshold: ${this.config.stuckThresholdMs}ms`
    );

    this.isStopped = false;
    this.scheduleNext();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearTimeout(this.intervalHandle);
      this.intervalHandle = undefined;
    }

    this.isStopped = true;
    this.logger.info('Stopped reconciliation');
  }

  private scheduleNext(): void {
    if (this.isStopped) return;

    const interval = this.scheduler.getCurrentInterval();
    this.intervalHandle = setTimeout(() => {
      void this.run();
    }, interval);
  }

  private async run(): Promise<void> {
    if (this.isRunning || this.isStopped) return;

    // Check if reconciliation has been paused due to consecutive failures
    if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
      this.logger.error(
        `Reconciliation paused after ${this.MAX_CONSECUTIVE_FAILURES} consecutive failures. ` +
          `Call forceRun() to retry or check database/Redis connectivity.`
      );
      // Still schedule next run in case issue resolves
      this.scheduleNext();
      return;
    }

    this.isRunning = true;

    try {
      const startTime = Date.now();

      const { toReEnqueue: jobsToReEnqueue, deadJobIds } =
        await this.repository.getAndMarkStuckJobs(
          this.adapter.queueName,
          this.config.stuckThresholdMs,
          this.config.batchSize
        );

      const totalStuckJobs = jobsToReEnqueue.length + deadJobIds.length;

      if (totalStuckJobs > 0) {
        this.logger.info(
          `Found ${totalStuckJobs} stuck jobs for queue: ${this.adapter.queueName}`
        );

        // Log dead jobs
        if (deadJobIds.length > 0) {
          this.logger.warn(
            `${deadJobIds.length} jobs exceeded max attempts and marked as dead`
          );
        }

        // Re-enqueue jobs with configurable rate limiting
        let reEnqueuedCount = 0;
        let failedCount = 0;
        const RATE_LIMIT_MS = Math.floor(1000 / this.config.rateLimitPerSecond);

        for (const job of jobsToReEnqueue) {
          try {
            await this.adapter.reEnqueueJob(job);
            reEnqueuedCount++;

            // Rate limit: wait between operations
            if (reEnqueuedCount < jobsToReEnqueue.length) {
              await this.sleep(RATE_LIMIT_MS);
            }
          } catch (error) {
            failedCount++;
            this.logger.error(`Failed to re-enqueue job ${job.job_id}:`, error);
          }
        }

        const duration = Date.now() - startTime;
        this.logger.info(
          `Reconciliation completed in ${duration}ms: ` +
            `${totalStuckJobs} stuck jobs found, ${reEnqueuedCount} re-enqueued, ` +
            `${failedCount} failed, ${deadJobIds.length} marked dead`
        );

        // Update scheduler with success rate
        const successRate =
          jobsToReEnqueue.length > 0 ? reEnqueuedCount / jobsToReEnqueue.length : 1.0;
        this.scheduler.recordResult(totalStuckJobs, successRate);
      } else {
        // No stuck jobs found
        this.scheduler.recordResult(0, 1.0);
      }

      // Reset failure counter on successful run
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures++;
      this.logger.error(
        `Reconciliation run failed (${this.consecutiveFailures}/${this.MAX_CONSECUTIVE_FAILURES}):`,
        error
      );

      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        this.logger.error(
          'Reconciliation has been paused. Check database and Redis connectivity.'
        );
      }

      throw new ReconciliationError(
        'Failed to complete reconciliation',
        error instanceof Error ? error : undefined
      );
    } finally {
      this.isRunning = false;
      this.scheduleNext();
    }
  }

  async forceRun(): Promise<void> {
    this.logger.info('Forcing immediate reconciliation run');
    // Reset failure counter to allow retry
    this.consecutiveFailures = 0;
    await this.run();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
