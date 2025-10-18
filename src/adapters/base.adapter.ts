import { QueueAdapter } from '../types/adapter';
import { JobRecord, JobStatus } from '../types/job';
import { JobRepository } from '../persistence/repository';
import { Logger } from '../utils/logger';
import { AnyQueue } from '../types/queue-types';

export abstract class BaseAdapter implements QueueAdapter {
  protected queue: AnyQueue;
  protected repository: JobRepository;
  protected logger: Logger;
  protected originalAdd?: Function;
  protected isDisposed = false;

  abstract readonly queueName: string;
  abstract readonly queueType: 'bull' | 'bullmq' | 'bee';

  constructor(queue: AnyQueue, repository: JobRepository, logger: Logger) {
    this.queue = queue;
    this.repository = repository;
    this.logger = logger;
  }

  initialize(): void {
    this.logger.info(
      `Initializing ${this.queueType} adapter for queue: ${this.queueName}`
    );
    this.wrapAddMethod();
    this.attachEventListeners();
  }

  abstract wrapAddMethod(): void;
  abstract attachEventListeners(): void;
  abstract reEnqueueJob(jobRecord: JobRecord): Promise<void>;

  async updateHeartbeat(jobId: string): Promise<void> {
    try {
      await this.repository.updateHeartbeat(this.queueName, this.queueType, jobId);
    } catch (error) {
      this.logger.error(`Failed to update heartbeat for job ${jobId}:`, error);
      // Don't throw - heartbeat failure shouldn't crash job processing
    }
  }

  dispose(): void {
    if (this.isDisposed) return;

    this.logger.info(`Disposing ${this.queueType} adapter for queue: ${this.queueName}`);

    // Restore original add method (if queue has add method)
    if (this.originalAdd && 'add' in this.queue) {
      (this.queue as any).add = this.originalAdd; // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    this.isDisposed = true;
  }

  protected validateJobData(jobName: string | undefined, data: unknown): void {
    const MAX_DATA_SIZE = 1048576; // 1MB
    const MAX_NAME_LENGTH = 255;

    // Fast name length validation
    if (jobName && jobName.length > MAX_NAME_LENGTH) {
      throw new Error(`Job name exceeds ${MAX_NAME_LENGTH} characters`);
    }

    // Use Buffer.byteLength for more accurate and faster size check
    // This is still synchronous but significantly faster than JSON.stringify
    try {
      const dataStr = JSON.stringify(data);
      const byteLength = Buffer.byteLength(dataStr, 'utf8');

      if (byteLength > MAX_DATA_SIZE) {
        throw new Error(
          `Job data exceeds ${MAX_DATA_SIZE} bytes (1MB limit). ` +
            `Actual size: ${byteLength} bytes`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('exceeds')) {
        throw error; // Re-throw our validation error
      }
      // JSON serialization error (circular reference, etc.)
      throw new Error(
        `Job data cannot be serialized to JSON: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  protected async handleJobCreated(
    jobId: string,
    jobName: string | undefined,
    data: unknown,
    maxAttempts?: number
  ): Promise<void> {
    try {
      // Validate before persisting
      this.validateJobData(jobName, data);

      await this.repository.createJob(
        this.queueName,
        this.queueType,
        jobId,
        jobName,
        data,
        maxAttempts || 3 // Use provided attempts or default to 3
      );
    } catch (error) {
      this.logger.error(`Failed to persist job ${jobId}:`, error);
      // Don't throw - let the job continue in Redis
    }
  }

  protected async handleJobStarted(jobId: string): Promise<void> {
    try {
      await this.repository.updateJobStatus(
        this.queueName,
        this.queueType,
        jobId,
        JobStatus.PROCESSING
      );
    } catch (error) {
      this.logger.error(`Failed to update job status ${jobId}:`, error);
    }
  }

  protected async handleJobCompleted(jobId: string): Promise<void> {
    try {
      await this.repository.updateJobStatus(
        this.queueName,
        this.queueType,
        jobId,
        JobStatus.COMPLETED
      );
    } catch (error) {
      this.logger.error(`Failed to mark job completed ${jobId}:`, error);
    }
  }

  protected async handleJobFailed(jobId: string, error: Error): Promise<void> {
    try {
      // Sanitize and truncate error message before persisting
      const sanitizedMessage = this.sanitizeErrorMessage(error.message);

      // SQL will atomically calculate status based on max_attempts in database
      await this.repository.updateJobError(
        this.queueName,
        this.queueType,
        jobId,
        sanitizedMessage
      );
    } catch (err) {
      this.logger.error(`Failed to mark job failed ${jobId}:`, err);
    }
  }

  /**
   * Sanitize and truncate error messages to prevent:
   * - Database storage bloat from oversized stack traces
   * - Sensitive information exposure (credentials, tokens, keys)
   * - Database errors from exceeding field limits
   */
  protected sanitizeErrorMessage(message: string): string {
    const MAX_ERROR_LENGTH = 5000; // Reasonable limit for debugging

    if (!message) {
      return 'Unknown error';
    }

    let sanitized = message;

    // Remove common sensitive patterns
    // PostgreSQL connection strings
    sanitized = sanitized.replace(
      /postgresql:\/\/[^:]+:[^@]+@[^\s]+/gi,
      'postgresql://***:***@***'
    );
    // Generic connection strings with passwords
    sanitized = sanitized.replace(
      /(?:password|passwd|pwd)[\s]*[=:][\s]*['"]?([^'"\s]+)['"]?/gi,
      'password=***'
    );
    // API keys and tokens
    sanitized = sanitized.replace(
      /(?:api[_-]?key|token|bearer)[\s]*[=:][\s]*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
      'api_key=***'
    );
    // AWS keys
    sanitized = sanitized.replace(/AKIA[0-9A-Z]{16}/g, 'AKIA***');
    // JWT tokens (basic pattern)
    sanitized = sanitized.replace(
      /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
      'jwt.***'
    );

    // Truncate if too long
    if (sanitized.length > MAX_ERROR_LENGTH) {
      sanitized = sanitized.substring(0, MAX_ERROR_LENGTH) + '... (truncated)';
    }

    return sanitized;
  }

  protected getJobIdAsString(jobId: string | number): string {
    return String(jobId);
  }
}
