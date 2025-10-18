import { setupSchema, teardownSchema } from '../helpers/schema';
import Bull from 'bull';
import { Pool } from 'pg';
import { JobGuard } from '../../src/jobguard';

// Integration test configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://localhost:5432/jobguard_test';

describe('Bull Integration Tests', () => {
  let queue: Bull.Queue;
  let jobGuard: JobGuard;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_URL });
    await setupSchema(pool);
  });

  beforeEach(async () => {
    // Clean up jobs table
    await pool.query('TRUNCATE TABLE jobguard_jobs');

    // Create Bull queue
    queue = new Bull('test-queue', REDIS_URL);
    await queue.empty();

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

  it('should persist job when added to queue', async () => {
    const jobData = { message: 'Hello World' };
    const job = await queue.add('test-job', jobData);

    // Give it a moment to persist
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Query PostgreSQL directly
    const result = await pool.query(
      'SELECT * FROM jobguard_jobs WHERE job_id = $1',
      [job.id.toString()]
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.queue_name).toBe('test-queue');
    expect(result.rows[0]?.queue_type).toBe('bull');
    expect(result.rows[0]?.status).toBe('pending');
    expect(result.rows[0]?.data).toEqual(jobData);
  });

  it('should update job status when processing', async () => {
    const job = await queue.add({ message: 'Test' });

    queue.process(async (_job) => {
      // Job takes long enough to check while processing
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { success: true };
    });

    // Wait for job to start processing
    await new Promise((resolve) => setTimeout(resolve, 150));

    const result = await pool.query(
      'SELECT status FROM jobguard_jobs WHERE job_id = $1',
      [job.id.toString()]
    );

    expect(result.rows[0]?.status).toBe('processing');
  });

  it('should mark job as completed', async () => {
    const job = await queue.add({ message: 'Complete me' });

    queue.process(async () => {
      return { done: true };
    });

    // Wait for completion
    await job.finished();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await pool.query(
      'SELECT status, completed_at FROM jobguard_jobs WHERE job_id = $1',
      [job.id.toString()]
    );

    expect(result.rows[0]?.status).toBe('completed');
    expect(result.rows[0]?.completed_at).toBeTruthy();
  });

  it('should track job failures', async () => {
    const job = await queue.add({ message: 'Fail me' });

    queue.process(async () => {
      throw new Error('Intentional failure');
    });

    // Wait for failure
    await new Promise((resolve) => setTimeout(resolve, 150));

    const result = await pool.query(
      'SELECT status, error_message, attempts FROM jobguard_jobs WHERE job_id = $1',
      [job.id.toString()]
    );

    expect(result.rows[0]?.status).toMatch(/failed|dead/);
    expect(result.rows[0]?.error_message).toContain('Intentional failure');
    expect(result.rows[0]?.attempts).toBeGreaterThan(0);
  });

  it('should retrieve queue statistics', async () => {
    // Add multiple jobs
    await queue.add({ id: 1 });
    await queue.add({ id: 2 });
    await queue.add({ id: 3 });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const stats = await jobGuard.getStats();

    expect(stats.queueName).toBe('test-queue');
    expect(stats.pending).toBeGreaterThanOrEqual(3);
    expect(stats.total).toBeGreaterThanOrEqual(3);
  });
});
