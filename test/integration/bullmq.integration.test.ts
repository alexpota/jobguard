import { setupSchema, teardownSchema } from '../helpers/schema';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { JobGuard } from '../../src/jobguard';

// Integration test configuration
const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://localhost:5432/jobguard_test';

describe('BullMQ Integration Tests', () => {
  let queue: Queue;
  let jobGuard: JobGuard;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_URL });
    await setupSchema(pool);
  });

  beforeEach(async () => {
    // Clean up jobs table
    await pool.query('TRUNCATE TABLE jobguard_jobs');

    // Create BullMQ queue
    queue = new Queue('test-bullmq-queue', { connection: { host: 'localhost', port: 6379 } });
    await queue.obliterate({ force: true });

    // Initialize JobGuard
    jobGuard = await JobGuard.create(queue, {
      postgres: POSTGRES_URL,
      reconciliation: {
        enabled: false, // Disable for controlled testing
      },
      logging: {
        level: 'error', // Suppress INFO logs in tests
      },
    });
  });

  afterEach(async () => {
    if (jobGuard) await jobGuard.shutdown();
    if (queue) await queue.close();
  });

  afterAll(async () => {
    await teardownSchema(pool);
    await pool.end();
  });

  it('should persist job when added to BullMQ queue', async () => {
    const jobData = { message: 'Hello from BullMQ' };
    const job = await queue.add('test-bullmq-job', jobData);

    // Give it a moment to persist
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Query PostgreSQL directly
    const result = await pool.query(
      'SELECT * FROM jobguard_jobs WHERE job_id = $1',
      [job.id!.toString()]
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.queue_name).toBe('test-bullmq-queue');
    expect(result.rows[0]?.queue_type).toBe('bullmq');
    expect(result.rows[0]?.status).toBe('pending');
    expect(result.rows[0]?.data).toEqual(jobData);
  });

  it('should retrieve queue statistics for BullMQ', async () => {
    // Add multiple jobs
    await queue.add('job1', { id: 1 });
    await queue.add('job2', { id: 2 });
    await queue.add('job3', { id: 3 });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const stats = await jobGuard.getStats();

    expect(stats.queueName).toBe('test-bullmq-queue');
    expect(stats.pending).toBeGreaterThanOrEqual(3);
    expect(stats.total).toBeGreaterThanOrEqual(3);
  });

  it('should track max_attempts from BullMQ options', async () => {
    const job = await queue.add('retry-job', { data: 'test' }, { attempts: 5 });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await pool.query(
      'SELECT max_attempts FROM jobguard_jobs WHERE job_id = $1',
      [job.id!.toString()]
    );

    expect(result.rows[0]?.max_attempts).toBe(5);
  });

  // New Worker tests to prevent regression of the QueueEvents bug
  describe('BullMQ Worker Integration', () => {
    let worker: any;

    afterEach(async () => {
      if (worker) {
        await worker.close();
        worker = undefined;
      }
    });

    it('should update job status to processing when worker starts', async () => {
      const { Worker } = require('bullmq');

      // Add job first
      const job = await queue.add('process-test', { value: 42 });

      // Create worker
      worker = new Worker(
        'test-bullmq-queue',
        async () => {
          // Keep job in processing state for verification
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { success: true };
        },
        { connection: { host: 'localhost', port: 6379 } }
      );

      // Wait for job to start processing
      await new Promise((resolve) => setTimeout(resolve, 150));

      const result = await pool.query(
        'SELECT status FROM jobguard_jobs WHERE job_id = $1',
        [job.id!.toString()]
      );

      expect(result.rows[0]?.status).toBe('processing');
    });

    it('should update job status to completed when worker finishes', async () => {
      const { Worker } = require('bullmq');

      // Add job
      const job = await queue.add('complete-test', { value: 99 });

      // Create worker that completes quickly
      worker = new Worker(
        'test-bullmq-queue',
        async () => {
          return { done: true };
        },
        { connection: { host: 'localhost', port: 6379 } }
      );

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 500));

      const result = await pool.query(
        'SELECT status, completed_at FROM jobguard_jobs WHERE job_id = $1',
        [job.id!.toString()]
      );

      expect(result.rows[0]?.status).toBe('completed');
      expect(result.rows[0]?.completed_at).toBeTruthy();
    });

    it('should track job failures with worker', async () => {
      const { Worker } = require('bullmq');

      // Add job with no retries
      const job = await queue.add('fail-test', { value: 0 }, { attempts: 1 });

      // Create worker that always fails
      worker = new Worker(
        'test-bullmq-queue',
        async () => {
          throw new Error('Intentional failure');
        },
        { connection: { host: 'localhost', port: 6379 } }
      );

      // Wait for failure
      await new Promise((resolve) => setTimeout(resolve, 500));

      const result = await pool.query(
        'SELECT status, error_message, attempts FROM jobguard_jobs WHERE job_id = $1',
        [job.id!.toString()]
      );

      // BullMQ uses "dead" status for jobs that exhausted retries
      expect(result.rows[0]?.status).toBe('dead');
      expect(result.rows[0]?.error_message).toContain('Intentional failure');
      expect(result.rows[0]?.attempts).toBeGreaterThan(0);
    });

    it('should handle multiple jobs concurrently with worker', async () => {
      const { Worker } = require('bullmq');

      // Add multiple jobs
      await Promise.all([
        queue.add('multi-1', { id: 1 }),
        queue.add('multi-2', { id: 2 }),
        queue.add('multi-3', { id: 3 }),
      ]);

      // Create worker
      worker = new Worker(
        'test-bullmq-queue',
        async (job: any) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { processed: job.data.id };
        },
        { connection: { host: 'localhost', port: 6379 } }
      );

      // Wait for all to complete
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const result = await pool.query(
        'SELECT COUNT(*) as count FROM jobguard_jobs WHERE status = $1 AND queue_name = $2',
        ['completed', 'test-bullmq-queue']
      );

      expect(parseInt(result.rows[0].count, 10)).toBeGreaterThanOrEqual(3);
    });
  });
});
