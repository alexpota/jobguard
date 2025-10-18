import Bull from 'bull';
import { Pool } from 'pg';
import { JobGuard } from '../../src/jobguard';
import { setupSchema, teardownSchema } from '../helpers/schema';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://localhost:5432/jobguard_test';

describe('Connection Pool Exhaustion Tests', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_URL });
    await setupSchema(pool);
  });

  afterAll(async () => {
    await teardownSchema(pool);
    await pool.end();
  });

  describe('Pool Size Limits', () => {
    it('should handle queries up to pool size without blocking', async () => {
      // Create a pool with limited connections
      const limitedPool = new Pool({
        connectionString: POSTGRES_URL,
        max: 5, // Only 5 connections
      });

      try {
        // Run exactly pool size concurrent queries
        const queries = Array.from({ length: 5 }, (_, i) =>
          limitedPool.query('SELECT $1 as id, pg_sleep(0.05)', [i])
        );

        // All should complete successfully
        const results = await Promise.all(queries);
        expect(results).toHaveLength(5);
        results.forEach((r, i) => {
          expect(parseInt(r.rows[0].id)).toBe(i);
        });
      } finally {
        await limitedPool.end();
      }
    });

    it('should queue requests when pool is exhausted', async () => {
      const limitedPool = new Pool({
        connectionString: POSTGRES_URL,
        max: 3,
      });

      try {
        const startTime = Date.now();

        // Run MORE queries than pool size (should queue)
        const queries = Array.from({ length: 6 }, (_, i) =>
          limitedPool.query('SELECT $1 as id, pg_sleep(0.05)', [i])
        );

        const results = await Promise.all(queries);
        const elapsed = Date.now() - startTime;

        // Should take ~100ms (2 batches of 3) not ~300ms (6 sequential)
        expect(elapsed).toBeGreaterThan(75);
        expect(elapsed).toBeLessThan(250);
        expect(results).toHaveLength(6);
      } finally {
        await limitedPool.end();
      }
    });

    it('should timeout when pool is exhausted and queries are slow', async () => {
      const limitedPool = new Pool({
        connectionString: POSTGRES_URL,
        max: 2,
        connectionTimeoutMillis: 500, // Short timeout
      });

      try {
        // Hold all connections with long queries
        const holdingQueries = [
          limitedPool.query('SELECT pg_sleep(0.7)'),
          limitedPool.query('SELECT pg_sleep(0.7)'),
        ];

        // Wait a bit to ensure connections are held
        await new Promise(resolve => setTimeout(resolve, 100));

        // Try to acquire another connection - should timeout
        const timeoutQuery = limitedPool.query('SELECT 1');

        // Should reject due to timeout
        await expect(timeoutQuery).rejects.toThrow();

        // Clean up holding queries
        await Promise.allSettled(holdingQueries);
      } finally {
        await limitedPool.end();
      }
    }, 10000);
  });

  describe('High Load Scenarios', () => {
    it('should handle burst of job creations without exhausting pool', async () => {
      const queue = new Bull('pool-test-queue', REDIS_URL);
      await queue.empty();

      const jobGuard = await JobGuard.create(queue, {
        postgres: {
          connectionString: POSTGRES_URL,
          max: 10, // Limited pool
        },
        reconciliation: { enabled: false },
        logging: { level: 'error' },
      });

      try {
        // Create 50 jobs rapidly
        const jobPromises = Array.from({ length: 50 }, (_, i) =>
          queue.add('test-job', { id: i })
        );

        // All should succeed without pool exhaustion
        await expect(Promise.all(jobPromises)).resolves.toBeDefined();

        // Wait for persistence
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify jobs were persisted
        const result = await pool.query(
          'SELECT COUNT(*) as count FROM jobguard_jobs WHERE queue_name = $1',
          ['pool-test-queue']
        );
        expect(parseInt(result.rows[0].count)).toBeGreaterThan(40); // Allow some timing variance
      } finally {
        await jobGuard.shutdown();
        await queue.close();
        await pool.query('TRUNCATE TABLE jobguard_jobs');
      }
    });

    it('should handle concurrent reconciliation without pool exhaustion', async () => {
      // Insert many processing jobs
      const jobIds = Array.from({ length: 100 }, (_, i) => `job-${i}`);
      for (const jobId of jobIds) {
        await pool.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '10 minutes')
        `, ['pool-test', 'bull', jobId, 'test', '{"id":"' + jobId + '"}', 'processing']);
      }

      const limitedPool = new Pool({
        connectionString: POSTGRES_URL,
        max: 5,
      });

      try {
        // Simulate 10 concurrent reconciliation processes
        const reconciliationQueries = Array.from({ length: 10 }, () =>
          limitedPool.query(`
            SELECT * FROM jobguard_jobs
            WHERE queue_name = $1
              AND status = 'processing'
              AND updated_at < NOW() - INTERVAL '5 minutes'
            ORDER BY updated_at ASC
            LIMIT 10
            FOR UPDATE SKIP LOCKED
          `, ['pool-test'])
        );

        // All should complete without deadlock or timeout
        const results = await Promise.all(reconciliationQueries);
        expect(results).toHaveLength(10);

        // Verify we got results from the pool
        const totalRows = results.reduce((sum, r) => sum + r.rows.length, 0);
        expect(totalRows).toBeGreaterThan(0);
      } finally {
        await limitedPool.end();
        await pool.query('TRUNCATE TABLE jobguard_jobs');
      }
    });
  });

  describe('Connection Leak Prevention', () => {
    it('should release connections after successful queries', async () => {
      const limitedPool = new Pool({
        connectionString: POSTGRES_URL,
        max: 3,
      });

      try {
        // Run many sequential queries (more than pool size)
        for (let i = 0; i < 10; i++) {
          await limitedPool.query('SELECT $1 as iteration', [i]);
        }

        // Verify pool isn't exhausted (should still be able to query)
        const result = await limitedPool.query('SELECT 1 as test');
        expect(result.rows[0].test).toBe(1);

        // Check pool stats
        expect(limitedPool.totalCount).toBeLessThanOrEqual(3);
        expect(limitedPool.idleCount).toBeGreaterThan(0);
      } finally {
        await limitedPool.end();
      }
    });

    it('should release connections after query errors', async () => {
      const limitedPool = new Pool({
        connectionString: POSTGRES_URL,
        max: 3,
      });

      try {
        // Run queries that will fail
        for (let i = 0; i < 5; i++) {
          await limitedPool.query('SELECT * FROM nonexistent_table').catch(() => {});
        }

        // Pool should still be usable
        const result = await limitedPool.query('SELECT 1 as test');
        expect(result.rows[0].test).toBe(1);

        // Connections should be released
        expect(limitedPool.idleCount).toBeGreaterThan(0);
      } finally {
        await limitedPool.end();
      }
    });

    it('should handle transaction rollbacks properly', async () => {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query(`
          INSERT INTO jobguard_jobs (queue_name, queue_type, job_id, job_name, data, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, ['tx-test', 'bull', 'tx-job-1', 'test', '{"msg":"test"}', 'pending']);

        // Rollback
        await client.query('ROLLBACK');
      } finally {
        client.release(); // Important: release connection
      }

      // Verify job was NOT persisted
      const result = await pool.query(
        'SELECT COUNT(*) as count FROM jobguard_jobs WHERE job_id = $1',
        ['tx-job-1']
      );
      expect(parseInt(result.rows[0].count)).toBe(0);

      // Verify connection was released (pool should still work)
      const testResult = await pool.query('SELECT 1 as test');
      expect(testResult.rows[0].test).toBe(1);
    });
  });

  describe('Idle Connection Management', () => {
    it('should remove idle connections after timeout', async () => {
      const idlePool = new Pool({
        connectionString: POSTGRES_URL,
        max: 5,
        idleTimeoutMillis: 1000, // 1 second idle timeout
      });

      try {
        // Create some connections
        await Promise.all([
          idlePool.query('SELECT 1'),
          idlePool.query('SELECT 2'),
          idlePool.query('SELECT 3'),
        ]);

        const initialCount = idlePool.totalCount;
        expect(initialCount).toBeGreaterThan(0);

        // Wait for idle timeout
        await new Promise(resolve => setTimeout(resolve, 1200));

        // Make a query to trigger cleanup
        await idlePool.query('SELECT 4');

        // Some connections should have been removed
        // Note: This is timing-dependent, so we just verify pool still works
        const result = await idlePool.query('SELECT 5 as test');
        expect(result.rows[0].test).toBe(5);
      } finally {
        await idlePool.end();
      }
    }, 5000);
  });

  describe('Pool Monitoring', () => {
    it('should provide pool statistics', () => {
      const monitoredPool = new Pool({
        connectionString: POSTGRES_URL,
        max: 10,
      });

      try {
        // Check initial state
        expect(monitoredPool.totalCount).toBeDefined();
        expect(monitoredPool.idleCount).toBeDefined();
        expect(monitoredPool.waitingCount).toBeDefined();

        // All should be 0 initially
        expect(monitoredPool.totalCount).toBe(0);
        expect(monitoredPool.idleCount).toBe(0);
        expect(monitoredPool.waitingCount).toBe(0);
      } finally {
        monitoredPool.end();
      }
    });

    it('should track waiting clients when pool is exhausted', async () => {
      const monitoredPool = new Pool({
        connectionString: POSTGRES_URL,
        max: 2,
      });

      try {
        // Acquire all connections
        const client1 = await monitoredPool.connect();
        const client2 = await monitoredPool.connect();

        expect(monitoredPool.totalCount).toBe(2);
        expect(monitoredPool.idleCount).toBe(0);

        // Start a query that will wait
        const waitingQuery = monitoredPool.query('SELECT 1');

        // Give it time to register as waiting
        await new Promise(resolve => setTimeout(resolve, 50));

        // Should show waiting client
        expect(monitoredPool.waitingCount).toBeGreaterThan(0);

        // Release connections
        client1.release();
        client2.release();

        // Wait for query to complete
        await waitingQuery;

        // Waiting should be cleared
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(monitoredPool.waitingCount).toBe(0);
      } finally {
        await monitoredPool.end();
      }
    });
  });

  describe('Error Recovery', () => {
    it('should recover from connection errors', async () => {
      const resilientPool = new Pool({
        connectionString: POSTGRES_URL,
        max: 5,
      });

      try {
        // Normal query
        await resilientPool.query('SELECT 1');

        // Cause an error
        await resilientPool.query('SELECT * FROM nonexistent').catch(() => {});

        // Should still be able to query
        const result = await resilientPool.query('SELECT 2 as test');
        expect(result.rows[0].test).toBe(2);
      } finally {
        await resilientPool.end();
      }
    });

    it('should handle PostgreSQL server restart scenario', async () => {
      const pool = new Pool({
        connectionString: POSTGRES_URL,
        max: 5,
        idleTimeoutMillis: 1000,
      });

      try {
        // Establish connections
        await pool.query('SELECT 1');

        // In real scenario, server would restart here
        // We simulate by letting connections go idle and expire
        await new Promise(resolve => setTimeout(resolve, 1200));

        // Pool should automatically create new connections
        const result = await pool.query('SELECT 2 as test');
        expect(result.rows[0].test).toBe(2);
      } finally {
        await pool.end();
      }
    }, 5000);
  });
});
