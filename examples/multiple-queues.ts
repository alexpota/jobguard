/**
 * Multiple Queues Example
 *
 * This example shows how to use JobGuard with multiple independent queues.
 */

import Bull from 'bull';
import { JobGuard } from '../src';

const REDIS_URL = 'redis://localhost:6379';
const POSTGRES_URL = 'postgresql://localhost:5432/jobguard_dev';

async function main() {
  // Create multiple queues
  const emailQueue = new Bull('emails', REDIS_URL);
  const paymentQueue = new Bull('payments', REDIS_URL);
  const notificationQueue = new Bull('notifications', REDIS_URL);

  // Wrap each queue with JobGuard
  const emailGuard = await JobGuard.create(emailQueue, {
    postgres: POSTGRES_URL,
    logging: { level: 'info', prefix: '[Email]' },
  });

  const paymentGuard = await JobGuard.create(paymentQueue, {
    postgres: POSTGRES_URL,
    reconciliation: {
      maxAttempts: 5, // Payments are critical - more attempts
      stuckThresholdMs: 120000, // 2 minutes - faster recovery
    },
    logging: { level: 'info', prefix: '[Payment]' },
  });

  const notificationGuard = await JobGuard.create(notificationQueue, {
    postgres: POSTGRES_URL,
    reconciliation: {
      maxAttempts: 1, // Notifications are less critical
    },
    logging: { level: 'warn', prefix: '[Notification]' },
  });

  // Set up processors
  emailQueue.process(async (job) => {
    console.log(`Sending email to ${job.data.to}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { sent: true };
  });

  paymentQueue.process(async (job) => {
    console.log(`Processing payment of $${job.data.amount}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { processed: true, transactionId: Math.random().toString(36) };
  });

  notificationQueue.process(async (job) => {
    console.log(`Sending notification: ${job.data.message}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { notified: true };
  });

  // Add jobs to different queues
  await emailQueue.add({ to: 'user@example.com', subject: 'Welcome!' });
  await paymentQueue.add({ amount: 99.99, currency: 'USD' });
  await notificationQueue.add({ message: 'Your order is ready' });

  console.log('Jobs added to all queues');

  // Monitor all queues
  setInterval(async () => {
    const emailStats = await emailGuard.getStats();
    const paymentStats = await paymentGuard.getStats();
    const notificationStats = await notificationGuard.getStats();

    console.log('\n=== Queue Statistics ===');
    console.log(`Emails: ${emailStats.total} total, ${emailStats.completed} completed`);
    console.log(
      `Payments: ${paymentStats.total} total, ${paymentStats.completed} completed`
    );
    console.log(
      `Notifications: ${notificationStats.total} total, ${notificationStats.completed} completed`
    );
  }, 5000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down all queues...');
    await Promise.all([
      emailGuard.shutdown(),
      paymentGuard.shutdown(),
      notificationGuard.shutdown(),
    ]);
    await Promise.all([
      emailQueue.close(),
      paymentQueue.close(),
      notificationQueue.close(),
    ]);
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
