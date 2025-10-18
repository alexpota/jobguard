import { Pool } from 'pg';
import BullQueue from 'bull';
import { Queue as BullMQQueue } from 'bullmq';
import Redis from 'ioredis';
import { JobGuard } from '../../src';
import { cleanupDatabase } from './jest-setup';

describe('E2E: Job Max Attempts Tracking', () => {
  let pool: Pool;
  let redis: Redis;

  beforeAll(() => {
    pool = new Pool({ connectionString: global.E2E_POSTGRES_URL });
    redis = new Redis({
      host: global.E2E_REDIS_HOST,
      port: global.E2E_REDIS_PORT,
    });
  });

  afterAll(async () => {
    await pool.end();
    redis.disconnect();
  });

  beforeEach(async () => {
    await cleanupDatabase(pool);
  });

  describe('Bull Queue', () => {
    let bullQueue: BullQueue.Queue;
    let jobGuard: JobGuard;

    afterEach(async () => {
      if (jobGuard) await jobGuard.shutdown();
      if (bullQueue) await bullQueue.close();
    });

    it('should respect per-job max_attempts from database (regression test for Issue #8)', async () => {
      bullQueue = new BullQueue('test-bull-per-job', {
        redis: {
          host: global.E2E_REDIS_HOST,
          port: global.E2E_REDIS_PORT,
        },
      });

      jobGuard = await JobGuard.create(bullQueue, {
        postgres: {
          connectionString: global.E2E_POSTGRES_URL,
        },
        reconciliation: {
          enabled: false, // Don't need reconciliation for this test - just testing tracking
        },
        logging: {
          level: 'error', // Suppress INFO logs during tests
        },
      });

      // Create two jobs with different max_attempts
      const job1 = await bullQueue.add('test', { id: 1 }, { jobId: 'per-job-1', attempts: 2 });
      const job2 = await bullQueue.add('test', { id: 2 }, { jobId: 'per-job-2', attempts: 5 });

      // Wait for jobs to be tracked in PostgreSQL
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify jobs are tracked with correct max_attempts
      const result = await pool.query(
        'SELECT job_id, max_attempts FROM jobguard_jobs WHERE job_id IN ($1, $2) ORDER BY job_id',
        [job1.id, job2.id]
      );

      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].max_attempts).toBe(2);
      expect(result.rows[1].max_attempts).toBe(5);
    });
  });

  describe('BullMQ Queue', () => {
    let bullmqQueue: BullMQQueue;
    let jobGuard: JobGuard;

    afterEach(async () => {
      if (jobGuard) await jobGuard.shutdown();
      if (bullmqQueue) await bullmqQueue.close();
    });

    it('should respect per-job max_attempts from database (regression test for Issue #8)', async () => {
      bullmqQueue = new BullMQQueue('test-bullmq-per-job', {
        connection: {
          host: global.E2E_REDIS_HOST,
          port: global.E2E_REDIS_PORT,
        },
      });

      jobGuard = await JobGuard.create(bullmqQueue, {
        postgres: {
          connectionString: global.E2E_POSTGRES_URL,
        },
        reconciliation: {
          enabled: false, // Don't need reconciliation for this test - just testing tracking
        },
        logging: {
          level: 'error', // Suppress INFO logs during tests
        },
      });

      // Create two jobs with different max_attempts
      const job1 = await bullmqQueue.add('test', { id: 1 }, { jobId: 'per-job-bq-1', attempts: 2 });
      const job2 = await bullmqQueue.add('test', { id: 2 }, { jobId: 'per-job-bq-2', attempts: 5 });

      // Wait for jobs to be tracked in PostgreSQL
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify jobs are tracked with correct max_attempts
      const result = await pool.query(
        'SELECT job_id, max_attempts FROM jobguard_jobs WHERE job_id IN ($1, $2) ORDER BY job_id',
        [job1.id, job2.id]
      );

      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].max_attempts).toBe(2);
      expect(result.rows[1].max_attempts).toBe(5);
    });
  });
});
