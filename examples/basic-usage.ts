/**
 * Basic JobGuard Usage Example
 *
 * This example demonstrates how to add JobGuard to an existing Bull queue
 * for PostgreSQL durability and automatic recovery.
 */

import Bull from 'bull';
import { JobGuard } from '../src';

async function main() {
  // 1. Create your Bull queue as usual
  const queue = new Bull('email-queue', 'redis://localhost:6379');

  // 2. Wrap it with JobGuard for durability
  const jobGuard = await JobGuard.create(queue, {
    postgres: {
      host: 'localhost',
      port: 5432,
      database: 'jobguard_dev',
      user: 'postgres',
      password: 'postgres',
    },
    reconciliation: {
      enabled: true,
      intervalMs: 30000, // Check for stuck jobs every 30 seconds
      stuckThresholdMs: 300000, // Consider jobs stuck after 5 minutes
    },
    logging: {
      level: 'info',
    },
  });

  // 3. Set up job processor
  queue.process('send-email', async (job) => {
    console.log(`Processing email job ${job.id}:`, job.data);

    // Simulate email sending
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Simulate random failures for testing
    if (Math.random() < 0.1) {
      throw new Error('Failed to send email');
    }

    return { sent: true, timestamp: new Date() };
  });

  // 4. Add some jobs
  console.log('Adding jobs to queue...');

  for (let i = 0; i < 5; i++) {
    await queue.add('send-email', {
      to: `user${i}@example.com`,
      subject: 'Test Email',
      body: 'This is a test email',
    });
  }

  console.log('Jobs added. Processing...');

  // 5. Monitor queue statistics
  setInterval(async () => {
    const stats = await jobGuard.getStats();
    console.log('\nQueue Statistics:');
    console.log(`  Pending: ${stats.pending}`);
    console.log(`  Processing: ${stats.processing}`);
    console.log(`  Completed: ${stats.completed}`);
    console.log(`  Failed: ${stats.failed}`);
    console.log(`  Stuck: ${stats.stuck}`);
    console.log(`  Total: ${stats.total}`);
  }, 5000);

  // 6. Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await jobGuard.shutdown();
    await queue.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Run the example
main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
