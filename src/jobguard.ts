import { Pool } from 'pg';
import { JobGuardConfig } from './types/config';
import { JobStats } from './types/job';
import { QueueAdapter } from './types/adapter';
import { QueueDetector } from './adapters/detector';
import { JobRepository } from './persistence/repository';
import { ConnectionManager } from './persistence/connection';
import { Reconciler } from './reconciliation/reconciler';
import { Logger } from './utils/logger';
import { CircuitBreaker } from './utils/circuit-breaker';
import { AnyQueue } from './types/queue-types';

export class JobGuard {
  private connectionManager: ConnectionManager;
  private pool: Pool;
  private adapter: QueueAdapter;
  private repository: JobRepository;
  private reconciler?: Reconciler;
  private logger: Logger;
  private circuitBreaker: CircuitBreaker;
  private cleanupInterval?: NodeJS.Timeout;
  private initialized = false;
  private config: JobGuardConfig;
  private cleanupFailures = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 3;
  private initializationPromise?: Promise<void>;

  private constructor(queue: AnyQueue, config: JobGuardConfig) {
    // Validate inputs
    if (!queue) {
      throw new Error('Queue instance is required');
    }

    if (!config.postgres) {
      throw new Error('PostgreSQL configuration is required');
    }

    this.config = config;

    // Initialize logger first
    this.logger = new Logger(config.logging);

    // Setup PostgreSQL connection
    this.connectionManager = new ConnectionManager(config.postgres, this.logger);
    this.pool = this.connectionManager.getPool();

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      threshold: 5,
      timeout: 60000,
      name: 'jobguard-postgres',
    });

    // Create repository with connection manager for health checks
    this.repository = new JobRepository(
      this.pool,
      this.circuitBreaker,
      this.logger,
      this.connectionManager
    );

    // Detect and create adapter
    const detector = new QueueDetector();
    this.adapter = detector.createAdapter(queue, this.repository, this.logger);
  }

  /**
   * Create and initialize a new JobGuard instance
   * @param queue - The queue instance to monitor
   * @param config - JobGuard configuration
   * @returns Promise that resolves to initialized JobGuard instance
   */
  static async create(queue: AnyQueue, config: JobGuardConfig): Promise<JobGuard> {
    const instance = new JobGuard(queue, config);
    await instance.initialize();
    return instance;
  }

  private async initialize(): Promise<void> {
    // Prevent multiple initializations
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      try {
        // Test PostgreSQL connection before proceeding
        await this.connectionManager.testConnection();

        // Initialize adapter
        this.adapter.initialize();

        // Setup reconciliation
        if (this.config.reconciliation?.enabled !== false) {
          this.reconciler = new Reconciler(
            this.repository,
            this.adapter,
            this.config.reconciliation || {},
            this.logger
          );
          this.reconciler.start();
        }

        // Setup cleanup
        if (this.config.persistence?.cleanupEnabled !== false) {
          this.setupCleanup(this.config.persistence);
        }

        this.initialized = true;
        this.logger.info('JobGuard initialized successfully');
      } catch (error) {
        this.logger.error('JobGuard initialization failed:', error);
        throw error;
      }
    })();

    return this.initializationPromise;
  }

  /**
   * Wait for JobGuard to be fully initialized
   * Useful when using alternative initialization patterns
   */
  async waitReady(): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
    } else {
      throw new Error(
        'JobGuard not initializing - use JobGuard.create() or call initialize'
      );
    }
  }

  private setupCleanup(
    config: { retentionDays?: number; cleanupIntervalMs?: number } = {}
  ): void {
    const intervalMs = config.cleanupIntervalMs || 3600000; // 1 hour
    const retentionDays = config.retentionDays || 7;

    this.cleanupInterval = setInterval(() => {
      void (async () => {
        // Check if cleanup has been disabled due to consecutive failures
        if (this.cleanupFailures >= this.MAX_CONSECUTIVE_FAILURES) {
          this.logger.error(
            `Cleanup disabled after ${this.MAX_CONSECUTIVE_FAILURES} consecutive failures. ` +
              `Manual intervention required.`
          );
          return;
        }

        try {
          const deleted = await this.repository.deleteOldJobs(retentionDays);
          if (deleted > 0) {
            this.logger.info(`Cleaned up ${deleted} old jobs`);
          }
          // Reset failure counter on success
          this.cleanupFailures = 0;
        } catch (error) {
          this.cleanupFailures++;
          this.logger.error(
            `Cleanup failed (${this.cleanupFailures}/${this.MAX_CONSECUTIVE_FAILURES}):`,
            error
          );

          if (this.cleanupFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            this.logger.error(
              'Cleanup has been disabled. Check database connectivity and permissions.'
            );
          }
        }
      })();
    }, intervalMs);

    // Don't prevent process from exiting
    this.cleanupInterval.unref();

    this.logger.debug(
      `Cleanup scheduled: ${intervalMs}ms interval, ${retentionDays} days retention`
    );
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) {
      this.logger.warn('JobGuard is not initialized, nothing to shutdown');
      return;
    }

    this.logger.info('Shutting down JobGuard');

    // Stop reconciliation
    if (this.reconciler) {
      this.reconciler.stop();
    }

    // Stop cleanup
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Dispose adapter
    await this.adapter.dispose();

    // Close PostgreSQL connection
    await this.connectionManager.close();

    this.initialized = false;
    this.logger.info('JobGuard shutdown complete');
  }

  async getStats(): Promise<JobStats> {
    if (!this.initialized) {
      throw new Error('JobGuard is not initialized');
    }

    return this.repository.getStatistics(this.adapter.queueName);
  }

  async forceReconciliation(): Promise<void> {
    if (!this.initialized) {
      throw new Error('JobGuard is not initialized');
    }

    if (!this.reconciler) {
      throw new Error('Reconciliation is not enabled');
    }

    await this.reconciler.forceRun();
  }

  /**
   * Update the heartbeat timestamp for a job
   * Call this periodically from your job processor to indicate the job is still alive
   * @param jobId - The job ID to update heartbeat for
   */
  async updateHeartbeat(jobId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('JobGuard is not initialized');
    }

    await this.adapter.updateHeartbeat(jobId);
  }

  getQueueName(): string {
    return this.adapter.queueName;
  }

  getQueueType(): string {
    return this.adapter.queueType;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
