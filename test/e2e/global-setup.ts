import { startServices } from './helpers/docker';
import { waitForServices } from './helpers/wait-for-services';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

const POSTGRES_URL = 'postgresql://e2e_user:e2e_pass@localhost:5434/jobguard_e2e';
const REDIS_HOST = 'localhost';
const REDIS_PORT = 6380;

export default async function globalSetup() {
  console.log('\n🚀 E2E Test Suite - Global Setup\n');

  // Start Docker services
  await startServices();

  // Wait for services to be ready
  await waitForServices(POSTGRES_URL, REDIS_HOST, REDIS_PORT);

  // Apply schema
  console.log('📄 Applying database schema...');
  const pool = new Pool({ connectionString: POSTGRES_URL });

  try {
    // Check if schema already exists
    const checkResult = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'jobguard_jobs')"
    );

    if (checkResult.rows[0].exists) {
      console.log('✅ Schema already exists, skipping\n');
    } else {
      const schemaPath = join(__dirname, '../../schema/001_initial.sql');
      const schema = readFileSync(schemaPath, 'utf-8');
      await pool.query(schema);
      console.log('✅ Schema applied\n');
    }
  } catch (error) {
    console.error('❌ Failed to apply schema:', error);
    throw error;
  } finally {
    await pool.end();
  }

  // Store connection details in global for tests to use
  (global as any).E2E_POSTGRES_URL = POSTGRES_URL;
  (global as any).E2E_REDIS_HOST = REDIS_HOST;
  (global as any).E2E_REDIS_PORT = REDIS_PORT;

  console.log('✅ Global setup complete\n');
}
