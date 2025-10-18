import { setupSchema, teardownSchema } from '../helpers/schema';
import Queue from 'bee-queue';
import { Pool } from 'pg';
import { JobGuard } from '../../src/jobguard';

// Integration test configuration
const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://localhost:5432/jobguard_test';

describe('Bee-Queue Integration Tests', () => {
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

    // Create Bee-Queue
    queue = new Queue('test-bee-queue', {
      redis: { host: 'localhost', port: 6379 },
      isWorker: false,
    });

    // Initialize JobGuard
    jobGuard = await JobGuard.create(queue, {
      postgres: POSTGRES_URL,
      reconciliation: {
        enabled: false, // Disable for controlled testing
      },
      logging: {
        level: 'error', // Reduce noise in tests
      },
    });
  });

  afterEach(async () => {
    await jobGuard.shutdown();
    await queue.close();
  });

  afterAll(async () => {
    await teardownSchema(pool);
    await pool.end();
  });

  it('should persist job when added to Bee-Queue', async () => {
    const jobData = { message: 'Hello from Bee-Queue' };
    const job = queue.createJob(jobData);
    await job.save();

    // Give it a moment to persist
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Query PostgreSQL directly
    const result = await pool.query(
      'SELECT * FROM jobguard_jobs WHERE job_id = $1',
      [job.id.toString()]
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.queue_type).toBe('bee');
    expect(result.rows[0]?.status).toBe('pending');
    expect(result.rows[0]?.data).toEqual(jobData);
  });

  it('should retrieve queue statistics for Bee-Queue', async () => {
    // Add multiple jobs
    const job1 = queue.createJob({ id: 1 });
    const job2 = queue.createJob({ id: 2 });
    const job3 = queue.createJob({ id: 3 });

    await job1.save();
    await job2.save();
    await job3.save();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const stats = await jobGuard.getStats();

    expect(stats.pending).toBeGreaterThanOrEqual(3);
    expect(stats.total).toBeGreaterThanOrEqual(3);
  });

  it('should handle Bee-Queue without job names (undefined job_name)', async () => {
    const job = queue.createJob({ data: 'test' });
    await job.save();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await pool.query(
      'SELECT job_name FROM jobguard_jobs WHERE job_id = $1',
      [job.id.toString()]
    );

    // Bee-Queue doesn't have job names
    expect(result.rows[0]?.job_name).toBeNull();
  });

  it('should use queue name property, not redis.db', async () => {
    // Add a job first
    const job = queue.createJob({ test: 'data' });
    await job.save();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify queue name comes from Bee-Queue's name property
    const result = await pool.query(
      'SELECT DISTINCT queue_name FROM jobguard_jobs'
    );

    // Should be 'test-bee-queue' (from line 24), not a number or 'bee-queue'
    expect(result.rows[0]?.queue_name).toBe('test-bee-queue');
  });

  it('should avoid queue name collisions with multiple Bee queues', async () => {
    // Create second queue with different name but same redis db
    const queue2 = new Queue('another-bee-queue', {
      redis: { host: 'localhost', port: 6379, db: 0 }, // Same db as queue1
      isWorker: false,
    });

    const jobGuard2 = await JobGuard.create(queue2, {
      postgres: POSTGRES_URL,
      reconciliation: { enabled: false },
      logging: { level: 'error' },
    });

    try {
      // Add jobs to both queues
      const job1 = queue.createJob({ from: 'queue1' });
      const job2 = queue2.createJob({ from: 'queue2' });

      await job1.save();
      await job2.save();

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Query queue names
      const result = await pool.query(
        'SELECT queue_name, data FROM jobguard_jobs ORDER BY queue_name'
      );

      // Should have 2 distinct queue names, not collision
      const queueNames = result.rows.map((r: any) => r.queue_name);
      expect(queueNames).toContain('test-bee-queue');
      expect(queueNames).toContain('another-bee-queue');

      // Each job should be in correct queue
      const queue1Jobs = result.rows.filter((r: any) => r.queue_name === 'test-bee-queue');
      const queue2Jobs = result.rows.filter((r: any) => r.queue_name === 'another-bee-queue');

      expect(queue1Jobs[0]?.data).toEqual({ from: 'queue1' });
      expect(queue2Jobs[0]?.data).toEqual({ from: 'queue2' });
    } finally {
      await jobGuard2.shutdown();
      await queue2.close();
    }
  });
});
