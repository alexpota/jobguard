// Make E2E connection details available to all tests
declare global {
  var E2E_POSTGRES_URL: string;
  var E2E_REDIS_HOST: string;
  var E2E_REDIS_PORT: number;
}

// Increase timeout for all tests (crash recovery needs time for reconciliation)
jest.setTimeout(120000); // 2 minutes

// Cleanup function that tests can use
export async function cleanupDatabase(pool: any) {
  await pool.query('TRUNCATE TABLE jobguard_jobs CASCADE');
}
