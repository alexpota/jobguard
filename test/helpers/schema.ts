import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

export async function setupSchema(pool: Pool): Promise<void> {
  // Drop existing schema cleanly
  await pool.query(`
    DROP TRIGGER IF EXISTS update_jobguard_jobs_updated_at ON jobguard_jobs;
    DROP FUNCTION IF EXISTS update_updated_at_column();
    DROP TABLE IF EXISTS jobguard_jobs;
  `);

  // Load and execute the actual schema
  const schemaPath = join(__dirname, '../../schema/001_initial.sql');
  const schema = readFileSync(schemaPath, 'utf8');
  await pool.query(schema);
}

export async function teardownSchema(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TRIGGER IF EXISTS update_jobguard_jobs_updated_at ON jobguard_jobs;
    DROP FUNCTION IF EXISTS update_updated_at_column();
    DROP TABLE IF EXISTS jobguard_jobs;
  `);
}
