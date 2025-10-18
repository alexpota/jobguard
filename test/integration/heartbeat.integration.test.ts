import { setupSchema, teardownSchema } from '../helpers/schema';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { JobGuard } from '../../src/jobguard';

// Integration test configuration
const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://localhost:5432/jobguard_test';

describe('Heartbeat Integration Tests', () => {
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
    queue = new Queue('test-heartbeat-queue', { connection: { host: 'localhost', port: 6379 } });
    await queue.obliterate({ force: true });

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

  it('should initialize last_heartbeat when job starts processing', async () => {
    const job = await queue.add('test-job', { data: 'test' });

    // Wait for job to be created in PostgreSQL
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate job starting (this happens when a worker picks up the job)
    await pool.query(
      `UPDATE jobguard_jobs SET status = 'processing', started_at = NOW(), last_heartbeat = NOW() WHERE job_id = $1`,
      [job.id!.toString()]
    );

    const result = await pool.query(
      'SELECT last_heartbeat, started_at FROM jobguard_jobs WHERE job_id = $1',
      [job.id!.toString()]
    );

    expect(result.rows[0]?.last_heartbeat).not.toBeNull();
    expect(result.rows[0]?.started_at).not.toBeNull();
  });

  it('should update heartbeat timestamp via updateHeartbeat()', async () => {
    const job = await queue.add('test-job', { data: 'test' });
    const jobId = job.id!.toString();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Mark job as processing first
    await pool.query(
      `UPDATE jobguard_jobs SET status = 'processing', started_at = NOW(), last_heartbeat = NOW() WHERE job_id = $1`,
      [jobId]
    );

    // Get initial heartbeat
    const before = await pool.query(
      'SELECT last_heartbeat FROM jobguard_jobs WHERE job_id = $1',
      [jobId]
    );

    // Wait a bit to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Update heartbeat
    await jobGuard.updateHeartbeat(jobId);

    // Get updated heartbeat
    const after = await pool.query(
      'SELECT last_heartbeat FROM jobguard_jobs WHERE job_id = $1',
      [jobId]
    );

    expect(after.rows[0]?.last_heartbeat).not.toBeNull();
    expect(new Date(after.rows[0]?.last_heartbeat).getTime()).toBeGreaterThan(
      new Date(before.rows[0]?.last_heartbeat).getTime()
    );
  });

  it('should not update heartbeat for non-processing jobs', async () => {
    const job = await queue.add('test-job', { data: 'test' });
    const jobId = job.id!.toString();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Job is still 'pending', not 'processing'
    await jobGuard.updateHeartbeat(jobId);

    const result = await pool.query(
      'SELECT last_heartbeat FROM jobguard_jobs WHERE job_id = $1',
      [jobId]
    );

    // Heartbeat should be null since job is not processing
    expect(result.rows[0]?.last_heartbeat).toBeNull();
  });

  it('should detect stuck job using heartbeat', async () => {
    const job = await queue.add('test-job', { data: 'test' });
    const jobId = job.id!.toString();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Mark job as processing with an old heartbeat (2 seconds ago)
    await pool.query(
      `UPDATE jobguard_jobs
       SET status = 'processing',
           started_at = NOW(),
           last_heartbeat = NOW() - INTERVAL '2 seconds'
       WHERE job_id = $1`,
      [jobId]
    );

    // Query for stuck jobs with 1 second threshold
    const stuckJobs = await pool.query(
      `SELECT * FROM jobguard_jobs
       WHERE status = 'processing'
       AND COALESCE(last_heartbeat, updated_at) < NOW() - INTERVAL '1 second'`,
      []
    );

    expect(stuckJobs.rows).toHaveLength(1);
    expect(stuckJobs.rows[0]?.job_id).toBe(jobId);
  });

  it('should NOT detect job with fresh heartbeat as stuck', async () => {
    const job = await queue.add('test-job', { data: 'test' });
    const jobId = job.id!.toString();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Mark job as processing with fresh heartbeat
    await pool.query(
      `UPDATE jobguard_jobs
       SET status = 'processing',
           started_at = NOW(),
           last_heartbeat = NOW()
       WHERE job_id = $1`,
      [jobId]
    );

    // Query for stuck jobs with 1 second threshold
    const stuckJobs = await pool.query(
      `SELECT * FROM jobguard_jobs
       WHERE status = 'processing'
       AND COALESCE(last_heartbeat, updated_at) < NOW() - INTERVAL '1 second'`,
      []
    );

    expect(stuckJobs.rows).toHaveLength(0);
  });

  it('should fall back to updated_at when last_heartbeat is NULL', async () => {
    const job = await queue.add('test-job', { data: 'test' });
    const jobId = job.id!.toString();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Disable trigger temporarily to set updated_at in the past
    await pool.query('ALTER TABLE jobguard_jobs DISABLE TRIGGER update_jobguard_jobs_updated_at');

    try {
      // Mark job as processing but with NULL heartbeat (old behavior)
      await pool.query(
        `UPDATE jobguard_jobs
         SET status = 'processing',
             started_at = NOW(),
             updated_at = NOW() - INTERVAL '2 seconds',
             last_heartbeat = NULL
         WHERE job_id = $1`,
        [jobId]
      );

      // Query should fall back to updated_at
      const stuckJobs = await pool.query(
        `SELECT * FROM jobguard_jobs
         WHERE status = 'processing'
         AND COALESCE(last_heartbeat, updated_at) < NOW() - INTERVAL '1 second'`,
        []
      );

      expect(stuckJobs.rows).toHaveLength(1);
      expect(stuckJobs.rows[0]?.job_id).toBe(jobId);
    } finally {
      // Re-enable trigger
      await pool.query('ALTER TABLE jobguard_jobs ENABLE TRIGGER update_jobguard_jobs_updated_at');
    }
  });

  it('should handle multiple heartbeat updates correctly', async () => {
    const job = await queue.add('test-job', { data: 'test' });
    const jobId = job.id!.toString();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Mark job as processing
    await pool.query(
      `UPDATE jobguard_jobs
       SET status = 'processing',
           started_at = NOW(),
           last_heartbeat = NOW()
       WHERE job_id = $1`,
      [jobId]
    );

    const timestamps: Date[] = [];

    // Update heartbeat multiple times
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await jobGuard.updateHeartbeat(jobId);

      const result = await pool.query(
        'SELECT last_heartbeat FROM jobguard_jobs WHERE job_id = $1',
        [jobId]
      );
      timestamps.push(new Date(result.rows[0]?.last_heartbeat));
    }

    // Each heartbeat should be later than the previous
    expect(timestamps[1]!.getTime()).toBeGreaterThan(timestamps[0]!.getTime());
    expect(timestamps[2]!.getTime()).toBeGreaterThan(timestamps[1]!.getTime());
  });

  it('should preserve heartbeat when job completes', async () => {
    const job = await queue.add('test-job', { data: 'test' });
    const jobId = job.id!.toString();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Mark job as processing with heartbeat
    await pool.query(
      `UPDATE jobguard_jobs
       SET status = 'processing',
           started_at = NOW(),
           last_heartbeat = NOW()
       WHERE job_id = $1`,
      [jobId]
    );

    const beforeCompletion = await pool.query(
      'SELECT last_heartbeat FROM jobguard_jobs WHERE job_id = $1',
      [jobId]
    );

    // Mark job as completed
    await pool.query(
      `UPDATE jobguard_jobs
       SET status = 'completed',
           completed_at = NOW()
       WHERE job_id = $1`,
      [jobId]
    );

    const afterCompletion = await pool.query(
      'SELECT last_heartbeat FROM jobguard_jobs WHERE job_id = $1',
      [jobId]
    );

    // Heartbeat should be preserved after completion (for audit trail)
    expect(afterCompletion.rows[0]?.last_heartbeat).toEqual(
      beforeCompletion.rows[0]?.last_heartbeat
    );
  });
});
