// Quick script to test PostgreSQL connection from host
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://demo:demo123@localhost:5433/jobguard_demo'
});

pool.query('SELECT 1')
  .then(() => {
    console.log('SUCCESS');
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
