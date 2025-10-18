import { setupSchema, teardownSchema } from '../helpers/schema';
import Bull from 'bull';
import { Pool } from 'pg';
import { JobGuard } from '../../src/jobguard';

// Integration test configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://localhost:5432/jobguard_test';

describe('Partial Index Duplicate Prevention Tests', () => {
  let queue: Bull.Queue;
  let jobGuard: JobGuard;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_URL });
    await setupSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE jobguard_jobs');
    queue = new Bull('duplicate-test-queue', REDIS_URL);
    await queue.empty();

    jobGuard = await JobGuard.create(queue, {
      postgres: POSTGRES_URL,
      reconciliation: { enabled: false },
      logging: { level: 'error' },
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

  describe('Prevents Active Job Duplicates', () => {
    it('should prevent duplicate pending jobs', async () => {
      const jobId = 'test-job-123';

      // Manually insert a pending job
      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"msg":"first"}', 'pending']);

      // Try to insert the same job again - should violate unique index
      await expect(
        pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"msg":"second"}', 'pending'])
      ).rejects.toThrow(/duplicate key value violates unique constraint/);
    });

    it('should prevent duplicate processing jobs', async () => {
      const jobId = 'processing-job-456';

      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"msg":"processing"}', 'processing']);

      await expect(
        pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"msg":"duplicate"}', 'processing'])
      ).rejects.toThrow(/duplicate key value violates unique constraint/);
    });

    it('should prevent duplicate stuck jobs', async () => {
      const jobId = 'stuck-job-789';

      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"msg":"stuck"}', 'stuck']);

      await expect(
        pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"msg":"duplicate"}', 'stuck'])
      ).rejects.toThrow(/duplicate key value violates unique constraint/);
    });
  });

  describe('Allows Terminal State Duplicates', () => {
    it('should allow multiple completed jobs with same ID', async () => {
      const jobId = 'completed-job-123';

      // First completed job
      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"run":1}', 'completed']);

      // Second completed job - should be allowed (not in partial index)
      await expect(
        pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"run":2}', 'completed'])
      ).resolves.toBeTruthy();

      // Verify both exist
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM jobguard_jobs WHERE job_id = $1',
        [jobId]
      );
      expect(parseInt(result.rows[0].count)).toBe(2);
    });

    it('should allow multiple failed jobs with same ID', async () => {
      const jobId = 'failed-job-456';

      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, error_message)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"attempt":1}', 'failed', 'Error 1']);

      await expect(
        pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, error_message)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"attempt":2}', 'failed', 'Error 2'])
      ).resolves.toBeTruthy();

      const result = await pool.query(
        'SELECT COUNT(*) as count FROM jobguard_jobs WHERE job_id = $1',
        [jobId]
      );
      expect(parseInt(result.rows[0].count)).toBe(2);
    });

    it('should allow multiple dead jobs with same ID', async () => {
      const jobId = 'dead-job-789';

      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"attempt":1}', 'dead']);

      await expect(
        pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"attempt":2}', 'dead'])
      ).resolves.toBeTruthy();

      const result = await pool.query(
        'SELECT COUNT(*) as count FROM jobguard_jobs WHERE job_id = $1',
        [jobId]
      );
      expect(parseInt(result.rows[0].count)).toBe(2);
    });
  });

  describe('UPSERT Behavior with Partial Index', () => {
    it('should update pending job when re-inserted', async () => {
      const jobId = 'upsert-job-123';

      // Insert initial job
      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"version":1}', 'pending']);

      // UPSERT with new data (matches production query)
      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, attempts, max_attempts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (queue_name, queue_type, job_id)
          WHERE status NOT IN ('completed', 'failed', 'dead')
        DO UPDATE SET
          data = EXCLUDED.data,
          status = EXCLUDED.status,
          attempts = EXCLUDED.attempts,
          updated_at = NOW()
        RETURNING *
      `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"version":2}', 'pending', 0, 3]);

      // Verify data was updated
      const result = await pool.query(
        'SELECT data FROM jobguard_jobs WHERE job_id = $1',
        [jobId]
      );
      expect(result.rows[0].data).toEqual({ version: 2 });
    });

    it('should NOT update completed job when re-inserted', async () => {
      const jobId = 'protected-job-456';

      // Insert completed job
      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"result":"success"}', 'completed']);

      // Try to insert again with same job_id - should succeed (creates new row)
      // because completed jobs are NOT covered by the partial index
      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, attempts, max_attempts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"result":"changed"}', 'completed', 0, 3]);

      // Verify we now have TWO completed jobs with the same job_id
      const result = await pool.query(
        'SELECT COUNT(*) as count, array_agg(data) as all_data FROM jobguard_jobs WHERE job_id = $1',
        [jobId]
      );
      expect(parseInt(result.rows[0].count)).toBe(2);
      // Both records should exist with their original data
      expect(result.rows[0].all_data).toContainEqual({ result: 'success' });
      expect(result.rows[0].all_data).toContainEqual({ result: 'changed' });
    });

    it('should handle transition from active to terminal state', async () => {
      const jobId = 'transition-job-789';

      // Start with pending
      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"state":"pending"}', 'pending']);

      // Update to processing
      await pool.query(`
        UPDATE jobguard_jobs SET status = 'processing' WHERE job_id = $1
      `, [jobId]);

      // Update to completed (terminal state)
      await pool.query(`
        UPDATE jobguard_jobs SET status = 'completed' WHERE job_id = $1
      `, [jobId]);

      // Now we should be able to insert a NEW job with same ID (not in partial index anymore)
      await expect(
        pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, ['duplicate-test-queue', 'bull', jobId, 'test', '{"state":"new"}', 'pending'])
      ).resolves.toBeTruthy();

      // Should have 2 records now
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM jobguard_jobs WHERE job_id = $1',
        [jobId]
      );
      expect(parseInt(result.rows[0].count)).toBe(2);
    });
  });

  describe('Partial Index Constraint Coverage', () => {
    it('should verify index only covers non-terminal states', async () => {
      const result = await pool.query(`
        SELECT
          indexdef
        FROM pg_indexes
        WHERE indexname = 'idx_unique_active_job'
      `);

      expect(result.rows[0].indexdef).toContain("WHERE");
      // PostgreSQL may rewrite "NOT IN" to "<> ALL" - both are functionally equivalent
      expect(result.rows[0].indexdef).toMatch(/(NOT IN|<> ALL)/);
      expect(result.rows[0].indexdef).toMatch(/completed.*failed.*dead/);
    });

    it('should allow same job_id across different queues', async () => {
      const jobId = 'shared-job-id';

      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['queue-1', 'bull', jobId, 'test', '{"queue":1}', 'pending']);

      // Different queue_name - should be allowed
      await expect(
        pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, ['queue-2', 'bull', jobId, 'test', '{"queue":2}', 'pending'])
      ).resolves.toBeTruthy();
    });

    it('should allow same job_id across different queue types', async () => {
      const jobId = 'multi-type-job';

      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['test-queue', 'bull', jobId, 'test', '{"type":"bull"}', 'pending']);

      // Different queue_type - should be allowed
      await expect(
        pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, ['test-queue', 'bullmq', jobId, 'test', '{"type":"bullmq"}', 'pending'])
      ).resolves.toBeTruthy();
    });
  });
});
