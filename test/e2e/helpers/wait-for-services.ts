import { Pool } from 'pg';
import Redis from 'ioredis';

const MAX_RETRIES = 30;
const RETRY_DELAY = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForPostgres(connectionString: string): Promise<void> {
  console.log('⏳ Waiting for PostgreSQL...');

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const pool = new Pool({ connectionString });
      await pool.query('SELECT 1');
      await pool.end();
      console.log('✅ PostgreSQL is ready');
      return;
    } catch (error) {
      if (i === MAX_RETRIES - 1) {
        throw new Error(`PostgreSQL not ready after ${MAX_RETRIES} attempts`);
      }
      await sleep(RETRY_DELAY);
    }
  }
}

export async function waitForRedis(host: string, port: number): Promise<void> {
  console.log('⏳ Waiting for Redis...');

  for (let i = 0; i < MAX_RETRIES; i++) {
    let redis: Redis | null = null;
    try {
      redis = new Redis({ host, port, maxRetriesPerRequest: 1 });
      await redis.ping();
      redis.disconnect();
      console.log('✅ Redis is ready');
      return;
    } catch (error) {
      if (redis) redis.disconnect();
      if (i === MAX_RETRIES - 1) {
        throw new Error(`Redis not ready after ${MAX_RETRIES} attempts`);
      }
      await sleep(RETRY_DELAY);
    }
  }
}

export async function waitForServices(
  postgresUrl: string,
  redisHost: string,
  redisPort: number
): Promise<void> {
  await Promise.all([
    waitForPostgres(postgresUrl),
    waitForRedis(redisHost, redisPort),
  ]);
  console.log('🎉 All services ready\n');
}
