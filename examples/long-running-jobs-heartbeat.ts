/**
 * Long-Running Jobs with Heartbeat Example
 *
 * This example demonstrates how to use heartbeats for jobs with dynamic
 * or long execution times (seconds to hours).
 *
 * Problem: With a fixed stuckThresholdMs, you face a trade-off:
 * - Set it low (5 min) → Fast recovery but false positives for long jobs
 * - Set it high (2 hours) → No false positives but slow recovery
 *
 * Solution: Use heartbeats! Jobs signal liveness every 30-60 seconds,
 * allowing both fast recovery AND support for long-running jobs.
 */

import { Queue, Worker } from 'bullmq';
import { JobGuard } from '../src';

const REDIS_URL = { host: 'localhost', port: 6379 };
const POSTGRES_URL = 'postgresql://localhost:5432/jobguard_dev';

async function main() {
  console.log('🚀 Long-Running Jobs with Heartbeat Demo\n');

  // Create queue
  const queue = new Queue('data-processing', { connection: REDIS_URL });

  // Initialize JobGuard with SHORT threshold (works with heartbeats!)
  const jobGuard = await JobGuard.create(queue, {
    postgres: POSTGRES_URL,
    reconciliation: {
      enabled: true,
      stuckThresholdMs: 300000, // 5 minutes - fast recovery!
      intervalMs: 30000, // Check every 30 seconds
    },
    logging: { level: 'info', prefix: '[JobGuard]' },
  });

  console.log('✅ JobGuard initialized with 5-minute stuck threshold\n');

  // Worker with heartbeat for long-running jobs
  const worker = new Worker(
    'data-processing',
    async (job) => {
      const { duration, items } = job.data;
      const startTime = Date.now();

      console.log(`\n📋 Job ${job.id} started (expected duration: ${duration / 1000}s)`);
      console.log(`   Processing ${items} items...`);

      // Setup heartbeat interval (every 30 seconds)
      const heartbeatInterval = setInterval(async () => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   💓 Heartbeat for job ${job.id} (${elapsed}s elapsed)`);

        try {
          await jobGuard.updateHeartbeat(job.id!);
        } catch (error) {
          console.error(`   ⚠️  Heartbeat failed: ${error}`);
          // Don't throw - heartbeat failure shouldn't crash the job
        }
      }, 30000); // Update every 30 seconds

      try {
        // Simulate long-running work (processing batches)
        const itemsPerBatch = 100;
        const batchCount = Math.ceil(items / itemsPerBatch);
        const timePerBatch = duration / batchCount;

        for (let i = 0; i < batchCount; i++) {
          // Process batch
          await new Promise((resolve) => setTimeout(resolve, timePerBatch));

          const progress = ((i + 1) / batchCount) * 100;
          console.log(`   📊 Progress: ${progress.toFixed(0)}% (batch ${i + 1}/${batchCount})`);

          // Heartbeat is automatically sent every 30s in background
        }

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   ✅ Job ${job.id} completed in ${totalTime}s`);

        return { processed: items, duration: totalTime };
      } finally {
        // IMPORTANT: Always clear the heartbeat interval
        clearInterval(heartbeatInterval);
        console.log(`   🛑 Stopped heartbeat for job ${job.id}`);
      }
    },
    { connection: REDIS_URL }
  );

  // Add jobs with different durations
  console.log('📝 Adding jobs with various durations:\n');

  const jobs = [
    { name: 'Quick job', duration: 10000, items: 100 }, // 10 seconds
    { name: 'Medium job', duration: 120000, items: 500 }, // 2 minutes
    { name: 'Long job', duration: 300000, items: 1000 }, // 5 minutes
    { name: 'Very long job', duration: 600000, items: 2000 }, // 10 minutes
  ];

  for (const jobData of jobs) {
    await queue.add('process-data', jobData);
    console.log(`   ✓ Added: ${jobData.name} (${jobData.duration / 1000}s, ${jobData.items} items)`);
  }

  console.log('\n🎯 All jobs added! Watch the heartbeats...\n');
  console.log('💡 Benefits:');
  console.log('   - Short stuck threshold (5 min) = fast recovery for crashed jobs');
  console.log('   - Heartbeats prevent false positives for long-running jobs');
  console.log('   - 10-minute job works fine despite 5-minute threshold!\n');

  // Monitor queue statistics
  let statsCount = 0;
  const statsInterval = setInterval(async () => {
    const stats = await jobGuard.getStats();

    if (statsCount % 2 === 0) {
      // Print every 60 seconds (every 2nd interval)
      console.log('\n📊 Queue Statistics:');
      console.log(`   Pending: ${stats.pending}`);
      console.log(`   Processing: ${stats.processing}`);
      console.log(`   Completed: ${stats.completed}`);
      console.log(`   Failed: ${stats.failed}`);
      console.log(`   Stuck: ${stats.stuck}`);
    }

    statsCount++;

    // Exit when all jobs are done
    if (stats.completed + stats.failed + stats.dead >= jobs.length) {
      clearInterval(statsInterval);

      console.log('\n\n✅ All jobs completed!');
      console.log('🎉 Heartbeat mechanism successfully handled dynamic job durations\n');

      await shutdown();
    }
  }, 30000); // Check every 30 seconds

  // Graceful shutdown
  async function shutdown() {
    console.log('🔄 Shutting down gracefully...');
    await worker.close();
    await jobGuard.shutdown();
    await queue.close();
    console.log('👋 Goodbye!\n');
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Demonstrate crash recovery
  setTimeout(async () => {
    console.log('\n\n⚠️  DEMO: Simulating worker crash during long job...\n');

    // Simulate crash by pausing the queue (jobs become stuck)
    await queue.pause();
    console.log('   🔴 Worker crashed! Jobs are now stuck in processing state');
    console.log('   ⏱️  Without heartbeats, recovery would take hours...');
    console.log('   💓 With heartbeats, stuck detection happens in ~5 minutes\n');

    // Wait 30 seconds then "recover"
    setTimeout(async () => {
      console.log('   🔄 Worker recovered! Resuming queue...\n');
      await queue.resume();

      // Force reconciliation to demonstrate fast recovery
      setTimeout(async () => {
        console.log('   🔍 Triggering reconciliation to recover stuck jobs...\n');
        await jobGuard.forceReconciliation();
      }, 2000);
    }, 30000);
  }, 45000); // Trigger crash after 45 seconds
}

// Run the example
main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
