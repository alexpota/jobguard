import { Pool } from 'pg';
import { Queue as BullQueue } from 'bull';
import { Queue as BullMQQueue } from 'bullmq';
import { JobStatus } from '../../../src/types/job';

type AnyQueue = BullQueue | BullMQQueue;

export interface JobState {
  postgresStatus: JobStatus | null;
  postgresAttempts: number;
  redisState: string | null;
  redisExists: boolean;
}

export async function getJobState(
  pool: Pool,
  queue: AnyQueue,
  jobId: string
): Promise<JobState> {
  // Check PostgreSQL
  const pgResult = await pool.query(
    'SELECT status, attempts FROM jobguard_jobs WHERE job_id = $1',
    [jobId]
  );

  const postgresStatus = pgResult.rows[0]?.status || null;
  const postgresAttempts = pgResult.rows[0]?.attempts || 0;

  // Check Redis
  let redisState: string | null = null;
  let redisExists = false;

  try {
    const job = await queue.getJob(jobId);
    if (job) {
      redisExists = true;
      // @ts-ignore - getState exists on both Bull and BullMQ
      const state = await job.getState();
      redisState = state;
    }
  } catch (error) {
    // Job doesn't exist in Redis
  }

  return {
    postgresStatus,
    postgresAttempts,
    redisState,
    redisExists,
  };
}

export async function waitForJobStatus(
  pool: Pool,
  jobId: string,
  expectedStatus: JobStatus,
  timeoutMs = 10000
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await pool.query(
      'SELECT status FROM jobguard_jobs WHERE job_id = $1',
      [jobId]
    );

    if (result.rows[0]?.status === expectedStatus) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Job ${jobId} did not reach status ${expectedStatus} within ${timeoutMs}ms`
  );
}

export async function getJobCount(pool: Pool, status: JobStatus): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM jobguard_jobs WHERE status = $1',
    [status]
  );

  return parseInt(result.rows[0].count, 10);
}

export async function assertJobInPostgres(
  pool: Pool,
  jobId: string,
  expectedStatus: JobStatus
): Promise<void> {
  const result = await pool.query(
    'SELECT status FROM jobguard_jobs WHERE job_id = $1',
    [jobId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Job ${jobId} not found in PostgreSQL`);
  }

  const actualStatus = result.rows[0].status;
  if (actualStatus !== expectedStatus) {
    throw new Error(
      `Job ${jobId} has status ${actualStatus}, expected ${expectedStatus}`
    );
  }
}

export async function assertJobNotInRedis(
  queue: AnyQueue,
  jobId: string
): Promise<void> {
  const job = await queue.getJob(jobId);
  if (job) {
    throw new Error(`Job ${jobId} still exists in Redis`);
  }
}
