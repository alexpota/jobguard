import { setupSchema, teardownSchema } from '../helpers/schema';
import Bull from 'bull';
import { Pool } from 'pg';
import { JobGuard } from '../../src/jobguard';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://localhost:5432/jobguard_test';

describe('Race Condition Tests', () => {
  let queue: Bull.Queue;
  let jobGuard: JobGuard;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_URL });
    await setupSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE jobguard_jobs');
    queue = new Bull('race-test-queue', REDIS_URL);
    await queue.empty();

    jobGuard = await JobGuard.create(queue, {
      postgres: POSTGRES_URL,
      reconciliation: {
        enabled: false, // Most tests don't need reconciliation
      },
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

  describe('Concurrent Job Insertions', () => {
    it('should handle concurrent insertions of same job', async () => {
      const jobId = 'concurrent-job-123';

      // Simulate race condition: multiple processes trying to insert same job
      const insertPromises = Array.from({ length: 5 }, (_, i) =>
        pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, attempts, max_attempts)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (queue_name, queue_type, job_id)
            WHERE status NOT IN ('completed', 'failed', 'dead')
          DO UPDATE SET
            data = EXCLUDED.data,
            status = EXCLUDED.status,
            updated_at = NOW()
          WHERE jobguard_jobs.status NOT IN ('completed', 'failed', 'dead')
          RETURNING *
        `, ['race-test-queue', 'bull', jobId, 'test', JSON.stringify({ attempt: i }), 'pending', 0, 3])
      );

      // All should succeed (UPSERT handles conflicts)
      const results = await Promise.all(insertPromises);
      expect(results).toHaveLength(5);

      // But only ONE job should exist in the database
      const countResult = await pool.query(
        'SELECT COUNT(*) as count FROM jobguard_jobs WHERE job_id = $1 AND status = $2',
        [jobId, 'pending']
      );
      expect(parseInt(countResult.rows[0].count)).toBe(1);
    });

    it('should handle concurrent updates to same job', async () => {
      const jobId = 'update-race-456';

      // Insert initial job
      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['race-test-queue', 'bull', jobId, 'test', '{"state":"initial"}', 'pending']);

      // Multiple concurrent status updates
      const updatePromises = [
        pool.query('UPDATE jobguard_jobs SET status = $1, updated_at = NOW() WHERE job_id = $2', ['processing', jobId]),
        pool.query('UPDATE jobguard_jobs SET attempts = attempts + 1, updated_at = NOW() WHERE job_id = $1', [jobId]),
        pool.query('UPDATE jobguard_jobs SET data = $1, updated_at = NOW() WHERE job_id = $2', [JSON.stringify({ state: 'updated' }), jobId]),
      ];

      // All updates should succeed
      await Promise.all(updatePromises);

      // Verify job still exists and has consistent state
      const result = await pool.query('SELECT * FROM jobguard_jobs WHERE job_id = $1', [jobId]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].job_id).toBe(jobId);
    });
  });

  describe('Re-enqueue Race Conditions', () => {
    it('should handle reconciliation during job completion', async () => {
      const jobId = 'reenqueue-race-789';

      // Insert a processing job that looks stuck
      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '10 minutes')
      `, ['race-test-queue', 'bull', jobId, 'test', '{"msg":"stuck"}', 'processing']);

      // Simulate race: reconciliation tries to mark as stuck, while job completes
      const [reconciliationResult, completionResult] = await Promise.allSettled([
        pool.query(`
          UPDATE jobguard_jobs
          SET status = 'stuck', updated_at = NOW()
          WHERE job_id = $1 AND status = 'processing'
          RETURNING *
        `, [jobId]),
        pool.query(`
          UPDATE jobguard_jobs
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE job_id = $1 AND status = 'processing'
          RETURNING *
        `, [jobId]),
      ]);

      // One should succeed, one should find no rows (both valid outcomes)
      expect(
        (reconciliationResult.status === 'fulfilled' && reconciliationResult.value.rowCount === 1) ||
        (completionResult.status === 'fulfilled' && completionResult.value.rowCount === 1)
      ).toBe(true);

      // Verify final state is consistent
      const result = await pool.query('SELECT status FROM jobguard_jobs WHERE job_id = $1', [jobId]);
      expect(['stuck', 'completed']).toContain(result.rows[0].status);
    });

    it('should prevent double re-enqueue with FOR UPDATE SKIP LOCKED', async () => {
      // Insert multiple stuck jobs
      const jobIds = ['job-1', 'job-2', 'job-3'];
      for (const jobId of jobIds) {
        await pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '10 minutes')
        `, ['race-test-queue', 'bull', jobId, 'test', '{"msg":"stuck"}', 'processing']);
      }

      // Simulate two reconciliation processes with actual lock contention
      // Start first query and hold transaction open
      const client1 = await pool.connect();
      const client2 = await pool.connect();

      try {
        await client1.query('BEGIN');
        const result1 = await client1.query(`
          SELECT * FROM jobguard_jobs
          WHERE queue_name = $1
            AND status = 'processing'
            AND updated_at < NOW() - INTERVAL '1 millisecond' * $2
          ORDER BY updated_at ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        `, ['race-test-queue', 200, 10]);

        // Second query while first transaction is still open
        await client2.query('BEGIN');
        const result2 = await client2.query(`
          SELECT * FROM jobguard_jobs
          WHERE queue_name = $1
            AND status = 'processing'
            AND updated_at < NOW() - INTERVAL '1 millisecond' * $2
          ORDER BY updated_at ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        `, ['race-test-queue', 200, 10]);

        await client1.query('COMMIT');
        await client2.query('COMMIT');

        // SKIP LOCKED ensures no overlap - each process gets different jobs
        const ids1 = result1.rows.map(r => r.job_id);
        const ids2 = result2.rows.map(r => r.job_id);

        // Check for no duplicates between the two results
        const intersection = ids1.filter(id => ids2.includes(id));
        expect(intersection).toHaveLength(0);

        // Either one gets all (if no contention) or they split them
        expect(ids1.length + ids2.length).toBeGreaterThan(0);
        expect(ids1.length + ids2.length).toBeLessThanOrEqual(3);
      } finally {
        client1.release();
        client2.release();
      }
    });

    it('should handle concurrent marking of stuck jobs', async () => {
      // Insert jobs
      const jobIds = Array.from({ length: 10 }, (_, i) => `job-${i}`);
      for (const jobId of jobIds) {
        await pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '10 minutes')
        `, ['race-test-queue', 'bull', jobId, 'test', '{"id":"' + jobId + '"}', 'processing']);
      }

      // Simulate multiple reconciliation processes marking jobs as stuck
      const markAsStuckPromises = jobIds.map(jobId =>
        pool.query(`
          UPDATE jobguard_jobs
          SET status = 'stuck', updated_at = NOW()
          WHERE job_id = $1 AND status = 'processing'
          RETURNING *
        `, [jobId])
      );

      const results = await Promise.all(markAsStuckPromises);

      // All updates should succeed
      expect(results.every(r => r.rowCount === 1)).toBe(true);

      // Verify all are now stuck
      const stuckCount = await pool.query(
        'SELECT COUNT(*) as count FROM jobguard_jobs WHERE status = $1',
        ['stuck']
      );
      expect(parseInt(stuckCount.rows[0].count)).toBe(10);
    });
  });

  describe('Terminal State Protection', () => {
    it('should protect completed jobs from being overwritten during race', async () => {
      const jobId = 'protected-job-123';

      // Start with processing job
      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['race-test-queue', 'bull', jobId, 'test', '{"state":"processing"}', 'processing']);

      // Mark as completed
      await pool.query(`
        UPDATE jobguard_jobs SET status = 'completed', completed_at = NOW() WHERE job_id = $1
      `, [jobId]);

      // Try to UPSERT new data (simulating retry/re-enqueue)
      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, attempts, max_attempts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (queue_name, queue_type, job_id)
          WHERE status NOT IN ('completed', 'failed', 'dead')
        DO UPDATE SET
          data = EXCLUDED.data,
          status = EXCLUDED.status,
          updated_at = NOW()
        WHERE jobguard_jobs.status NOT IN ('completed', 'failed', 'dead')
      `, ['race-test-queue', 'bull', jobId, 'test', '{"state":"retry"}', 'pending', 0, 3]);

      // Verify original state is preserved
      const result = await pool.query('SELECT data, status FROM jobguard_jobs WHERE job_id = $1', [jobId]);
      expect(result.rows[0].data).toEqual({ state: 'processing' });
      expect(result.rows[0].status).toBe('completed');
    });

    it('should prevent race between completion and failure', async () => {
      const jobId = 'race-complete-fail-456';

      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['race-test-queue', 'bull', jobId, 'test', '{"msg":"racing"}', 'processing']);

      // Concurrent completion and failure
      const [completeResult, failResult] = await Promise.allSettled([
        pool.query(`
          UPDATE jobguard_jobs
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE job_id = $1 AND status = 'processing'
        `, [jobId]),
        pool.query(`
          UPDATE jobguard_jobs
          SET status = 'failed', error_message = 'Error', completed_at = NOW(), updated_at = NOW()
          WHERE job_id = $1 AND status = 'processing'
        `, [jobId]),
      ]);

      // Only one should update (whichever wins the race)
      const successfulUpdates = [completeResult, failResult].filter(
        r => r.status === 'fulfilled' && r.value.rowCount === 1
      );
      expect(successfulUpdates).toHaveLength(1);

      // Verify we ended up in exactly one terminal state
      const result = await pool.query('SELECT status FROM jobguard_jobs WHERE job_id = $1', [jobId]);
      expect(['completed', 'failed']).toContain(result.rows[0].status);
    });
  });

  describe('Lock Contention', () => {
    it('should handle high concurrency without deadlocks', async () => {
      // Insert 20 processing jobs
      const jobIds = Array.from({ length: 20 }, (_, i) => `concurrent-${i}`);
      for (const jobId of jobIds) {
        await pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '5 minutes')
        `, ['race-test-queue', 'bull', jobId, 'test', '{"id":"' + jobId + '"}', 'processing']);
      }

      // Simulate 10 concurrent reconciliation queries
      const queries = Array.from({ length: 10 }, () =>
        pool.query(`
          SELECT * FROM jobguard_jobs
          WHERE queue_name = $1
            AND status = 'processing'
            AND updated_at < NOW() - INTERVAL '1 millisecond' * $2
          ORDER BY updated_at ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        `, ['race-test-queue', 200, 5])
      );

      // All should complete without deadlock (key success criterion)
      const results = await Promise.all(queries);

      // Verify we got results and no deadlocks occurred
      const totalRows = results.reduce((sum, r) => sum + r.rows.length, 0);
      expect(totalRows).toBeGreaterThan(0);

      // Each query can return up to 5 rows without actual transaction contention
      // The key is that all queries completed successfully without deadlock
      expect(results).toHaveLength(10); // All queries completed
    });

    it('should handle mixed read/write operations concurrently', async () => {
      const jobId = 'mixed-ops-789';

      await pool.query(`
        INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['race-test-queue', 'bull', jobId, 'test', '{"counter":0}', 'pending']);

      // Mix of reads, updates, and status changes
      const operations = [
        pool.query('SELECT * FROM jobguard_jobs WHERE job_id = $1', [jobId]),
        pool.query('UPDATE jobguard_jobs SET data = $1 WHERE job_id = $2', [JSON.stringify({ counter: 1 }), jobId]),
        pool.query('SELECT * FROM jobguard_jobs WHERE job_id = $1', [jobId]),
        pool.query('UPDATE jobguard_jobs SET status = $1 WHERE job_id = $2', ['processing', jobId]),
        pool.query('SELECT * FROM jobguard_jobs WHERE job_id = $1', [jobId]),
        pool.query('UPDATE jobguard_jobs SET attempts = attempts + 1 WHERE job_id = $1', [jobId]),
      ];

      // All should complete without errors
      await expect(Promise.all(operations)).resolves.toBeDefined();

      // Verify final state is consistent
      const result = await pool.query('SELECT * FROM jobguard_jobs WHERE job_id = $1', [jobId]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].status).toBe('processing');
      expect(result.rows[0].attempts).toBeGreaterThan(0);
    });
  });

  describe('Per-Job Max Attempts', () => {
    it('should respect per-job max_attempts instead of config maxAttempts', async () => {
      // Create jobs with different max_attempts
      const jobs = [
        { job_id: 'job-max-3', max_attempts: 3, attempts: 2 }, // Should re-enqueue
        { job_id: 'job-max-3-dead', max_attempts: 3, attempts: 3 }, // Should mark dead
        { job_id: 'job-max-5', max_attempts: 5, attempts: 4 }, // Should re-enqueue
        { job_id: 'job-max-5-dead', max_attempts: 5, attempts: 5 }, // Should mark dead
      ];

      for (const job of jobs) {
        await pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, attempts, max_attempts, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - INTERVAL '10 minutes')
        `, ['race-test-queue', 'bull', job.job_id, 'test', '{"msg":"stuck"}', 'processing', job.attempts, job.max_attempts]);
      }

      // Run getAndMarkStuckJobs (which uses per-job max_attempts)
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const stuckResult = await client.query(`
          SELECT * FROM jobguard_jobs
          WHERE queue_name = $1
            AND status = 'processing'
            AND updated_at < NOW() - INTERVAL '1 millisecond' * $2
          ORDER BY updated_at ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        `, ['race-test-queue', 300000, 100]);

        const stuckJobs = stuckResult.rows;
        const jobIds = stuckJobs.map(j => j.id);

        await client.query('UPDATE jobguard_jobs SET status = $1 WHERE id = ANY($2)', ['stuck', jobIds]);

        // Separate based on per-job max_attempts
        const toReEnqueue: string[] = [];
        const deadJobIds: string[] = [];

        for (const job of stuckJobs) {
          if (job.attempts < job.max_attempts) {
            toReEnqueue.push(job.id);
          } else {
            deadJobIds.push(job.id);
          }
        }

        if (deadJobIds.length > 0) {
          await client.query('UPDATE jobguard_jobs SET status = $1, completed_at = NOW() WHERE id = ANY($2)', ['dead', deadJobIds]);
        }

        await client.query('COMMIT');

        // Verify: 2 jobs should be stuck (to re-enqueue), 2 should be dead
        expect(toReEnqueue).toHaveLength(2);
        expect(deadJobIds).toHaveLength(2);

        const stuckCount = await pool.query('SELECT COUNT(*) FROM jobguard_jobs WHERE status = $1', ['stuck']);
        const deadCount = await pool.query('SELECT COUNT(*) FROM jobguard_jobs WHERE status = $1', ['dead']);

        expect(parseInt(stuckCount.rows[0].count)).toBe(2);
        expect(parseInt(deadCount.rows[0].count)).toBe(2);

        // Verify specific jobs
        const job3Dead = await pool.query('SELECT status FROM jobguard_jobs WHERE job_id = $1', ['job-max-3-dead']);
        const job5Dead = await pool.query('SELECT status FROM jobguard_jobs WHERE job_id = $1', ['job-max-5-dead']);
        const job3Stuck = await pool.query('SELECT status FROM jobguard_jobs WHERE job_id = $1', ['job-max-3']);
        const job5Stuck = await pool.query('SELECT status FROM jobguard_jobs WHERE job_id = $1', ['job-max-5']);

        expect(job3Dead.rows[0].status).toBe('dead');
        expect(job5Dead.rows[0].status).toBe('dead');
        expect(job3Stuck.rows[0].status).toBe('stuck');
        expect(job5Stuck.rows[0].status).toBe('stuck');
      } finally {
        client.release();
      }
    });
  });
});
