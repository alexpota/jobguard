import { Pool } from 'pg';
import { JobRecord, JobStatus, JobStats } from '../types/job';
import { QUERIES } from './queries';
import { CircuitBreaker } from '../utils/circuit-breaker';
import { Logger } from '../utils/logger';

import { ConnectionManager } from './connection';

export class JobRepository {
  private pool: Pool;
  private circuitBreaker: CircuitBreaker;
  private logger: Logger;
  private connectionManager?: ConnectionManager;

  constructor(
    pool: Pool,
    circuitBreaker: CircuitBreaker,
    logger: Logger,
    connectionManager?: ConnectionManager
  ) {
    this.pool = pool;
    this.circuitBreaker = circuitBreaker;
    this.logger = logger;
    this.connectionManager = connectionManager;
  }

  /**
   * Check pool health before critical operations
   * @private
   */
  private checkHealth(): void {
    if (this.connectionManager) {
      this.connectionManager.checkPoolHealth();
    }
  }

  /**
   * Execute operations within a transaction
   * Provides client for transaction-scoped queries
   */
  async withTransaction<T>(callback: (client: Pool) => Promise<T>): Promise<T> {
    return this.circuitBreaker.execute(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client as unknown as Pool);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async createJob(
    queueName: string,
    queueType: 'bull' | 'bullmq' | 'bee',
    jobId: string,
    jobName: string | undefined,
    data: unknown,
    maxAttempts = 3
  ): Promise<JobRecord> {
    return this.circuitBreaker.execute(async () => {
      const result = await this.pool.query(QUERIES.INSERT_JOB, [
        queueName,
        queueType,
        jobId,
        jobName,
        JSON.stringify(data),
        JobStatus.PENDING,
        0,
        maxAttempts,
      ]);

      const job = this.mapRowToJobRecord(result.rows[0]);
      this.logger.debug(`Created job: ${queueName}/${jobId}`);
      return job;
    });
  }

  async updateJobStatus(
    queueName: string,
    queueType: 'bull' | 'bullmq' | 'bee',
    jobId: string,
    status: JobStatus
  ): Promise<JobRecord | null> {
    return this.circuitBreaker.execute(async () => {
      const result = await this.pool.query(QUERIES.UPDATE_JOB_STATUS, [
        status,
        queueName,
        queueType,
        jobId,
      ]);

      if (result.rows.length === 0) {
        this.logger.warn(`Job not found for status update: ${queueName}/${jobId}`);
        return null;
      }

      const job = this.mapRowToJobRecord(result.rows[0]);
      this.logger.debug(`Updated job status: ${queueName}/${jobId} -> ${status}`);
      return job;
    });
  }

  async updateJobError(
    queueName: string,
    queueType: 'bull' | 'bullmq' | 'bee',
    jobId: string,
    error: string
  ): Promise<JobRecord | null> {
    return this.circuitBreaker.execute(async () => {
      // Status is calculated atomically in SQL based on attempts + 1 >= max_attempts
      // No need for maxAttempts parameter - it's already in the database record
      const result = await this.pool.query(QUERIES.UPDATE_JOB_ERROR, [
        error,
        queueName,
        queueType,
        jobId,
      ]);

      if (result.rows.length === 0) {
        this.logger.warn(`Job not found for error update: ${queueName}/${jobId}`);
        return null;
      }

      const updatedJob = this.mapRowToJobRecord(result.rows[0]);
      this.logger.debug(
        `Updated job error: ${queueName}/${jobId} -> ${updatedJob.status} ` +
          `(attempts: ${updatedJob.attempts}/${updatedJob.max_attempts})`
      );
      return updatedJob;
    });
  }

  async getStuckJobs(
    queueName: string,
    stuckThresholdMs: number,
    batchSize: number
  ): Promise<JobRecord[]> {
    return this.circuitBreaker.execute(async () => {
      const result = await this.pool.query(QUERIES.GET_STUCK_JOBS, [
        queueName,
        stuckThresholdMs,
        batchSize,
      ]);

      return result.rows.map((row) => this.mapRowToJobRecord(row));
    });
  }

  async markJobsAsStuck(jobIds: string[]): Promise<JobRecord[]> {
    return this.circuitBreaker.execute(async () => {
      const result = await this.pool.query(QUERIES.MARK_AS_STUCK, [jobIds]);
      return result.rows.map((row) => this.mapRowToJobRecord(row));
    });
  }

  async deleteOldJobs(retentionDays: number): Promise<number> {
    return this.circuitBreaker.execute(async () => {
      const result = await this.pool.query(QUERIES.DELETE_OLD_JOBS, [retentionDays]);
      return result.rowCount || 0;
    });
  }

  async getStatistics(queueName: string): Promise<JobStats> {
    return this.circuitBreaker.execute(async () => {
      const result = await this.pool.query(QUERIES.GET_STATISTICS, [queueName]);

      const stats: JobStats = {
        queueName,
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        stuck: 0,
        dead: 0,
        total: 0,
      };

      for (const row of result.rows) {
        const rowData = row as Record<string, unknown>;
        const status = rowData.status as keyof Omit<JobStats, 'queueName' | 'total'>;
        const count = parseInt(String(rowData.count), 10);
        stats[status] = count;
        stats.total += count;
      }

      return stats;
    });
  }

  async getJob(
    queueName: string,
    queueType: 'bull' | 'bullmq' | 'bee',
    jobId: string
  ): Promise<JobRecord | null> {
    return this.circuitBreaker.execute(async () => {
      const result = await this.pool.query(QUERIES.GET_JOB, [
        queueName,
        queueType,
        jobId,
      ]);

      if (result.rows.length === 0) {
        return null;
      }

      const job = this.mapRowToJobRecord(result.rows[0]);
      return job;
    });
  }

  async bulkUpdateStatus(jobIds: string[], status: JobStatus): Promise<JobRecord[]> {
    if (jobIds.length === 0) {
      return [];
    }

    return this.circuitBreaker.execute(async () => {
      const result = await this.pool.query(QUERIES.BULK_UPDATE_STATUS, [status, jobIds]);
      return result.rows.map((row) => this.mapRowToJobRecord(row));
    });
  }

  async bulkMarkDead(jobIds: string[]): Promise<JobRecord[]> {
    if (jobIds.length === 0) {
      return [];
    }

    return this.circuitBreaker.execute(async () => {
      const result = await this.pool.query(QUERIES.BULK_MARK_DEAD, [jobIds]);
      return result.rows.map((row) => this.mapRowToJobRecord(row));
    });
  }

  /**
   * Atomically find stuck jobs and mark them within a transaction
   * Prevents race conditions by locking rows with FOR UPDATE SKIP LOCKED
   */
  async getAndMarkStuckJobs(
    queueName: string,
    stuckThresholdMs: number,
    batchSize: number
  ): Promise<{ toReEnqueue: JobRecord[]; deadJobIds: string[] }> {
    // Check pool health before critical operation
    this.checkHealth();

    return this.withTransaction(async (client) => {
      // Get stuck jobs with row-level locks
      const stuckResult = await client.query(QUERIES.GET_STUCK_JOBS, [
        queueName,
        stuckThresholdMs,
        batchSize,
      ]);

      if (stuckResult.rows.length === 0) {
        return { toReEnqueue: [], deadJobIds: [] };
      }

      const stuckJobs = stuckResult.rows.map((row) => this.mapRowToJobRecord(row));
      const jobIds = stuckJobs.map((job) => job.id);

      // Mark all as stuck first
      await client.query(QUERIES.MARK_AS_STUCK, [jobIds]);

      const toReEnqueue: JobRecord[] = [];
      const deadJobIds: string[] = [];

      for (const job of stuckJobs) {
        if (job.attempts < job.max_attempts) {
          toReEnqueue.push(job);
        } else {
          deadJobIds.push(job.id);
        }
      }

      // Bulk mark dead jobs within same transaction
      if (deadJobIds.length > 0) {
        await client.query(QUERIES.BULK_MARK_DEAD, [deadJobIds]);
      }

      return { toReEnqueue, deadJobIds };
    });
  }

  async updateHeartbeat(
    queueName: string,
    queueType: 'bull' | 'bullmq' | 'bee',
    jobId: string
  ): Promise<JobRecord | null> {
    return this.circuitBreaker.execute(async () => {
      const result = await this.pool.query(QUERIES.UPDATE_HEARTBEAT, [
        queueName,
        queueType,
        jobId,
      ]);

      if (result.rows.length === 0) {
        this.logger.warn(
          `Job not found or not processing for heartbeat update: ${queueName}/${jobId}`
        );
        return null;
      }

      const job = this.mapRowToJobRecord(result.rows[0]);
      this.logger.debug(`Updated heartbeat: ${queueName}/${jobId}`);
      return job;
    });
  }

  private mapRowToJobRecord(row: Record<string, unknown>): JobRecord {
    return {
      id: row.id as string,
      queue_name: row.queue_name as string,
      queue_type: row.queue_type as 'bull' | 'bullmq' | 'bee',
      job_id: row.job_id as string,
      job_name: row.job_name as string | undefined,
      data: row.data,
      status: row.status as JobStatus,
      attempts: row.attempts as number,
      max_attempts: row.max_attempts as number,
      error_message: row.error_message as string | undefined,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
      started_at: row.started_at ? new Date(row.started_at as string) : undefined,
      completed_at: row.completed_at ? new Date(row.completed_at as string) : undefined,
      last_heartbeat: row.last_heartbeat
        ? new Date(row.last_heartbeat as string)
        : undefined,
    };
  }
}
