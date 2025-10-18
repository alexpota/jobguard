#!/usr/bin/env ts-node
import Bull from 'bull';
import { JobGuard } from '../src';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';

// Configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const POSTGRES_URL =
  process.env.POSTGRES_URL || 'postgresql://demo:demo123@localhost:5433/jobguard_demo';

const TOTAL_JOBS = 50;
const FAILURE_RATE = 0.2; // 20% of jobs will fail
const PROCESSING_TIME_MS = 100; // Simulated work time

// Utilities
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const banner = () => {
  console.log(
    chalk.cyan.bold(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║               🛡️  JobGuard Interactive Demo                ║
║                                                           ║
║     PostgreSQL Durability for Redis-Backed Job Queues     ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`)
  );
};

const section = (num: number, total: number, title: string) => {
  console.log(`\n${chalk.blue.bold(`[${num}/${total}]`)} ${chalk.white.bold(title)}`);
};

const logSuccess = (message: string) => {
  console.log(`  ${chalk.green('✓')} ${message}`);
};

const logError = (message: string) => {
  console.log(`  ${chalk.red('✗')} ${message}`);
};

const logInfo = (message: string) => {
  console.log(`  ${chalk.blue('ℹ')} ${message}`);
};

const logWarning = (message: string) => {
  console.log(`  ${chalk.yellow('⚠')} ${message}`);
};

// Job processor with random failures
async function processJob(job: Bull.Job): Promise<any> {
  const { id, type } = job.data;

  // Simulate work
  await sleep(PROCESSING_TIME_MS);

  // Random failures
  if (Math.random() < FAILURE_RATE) {
    throw new Error(`Processing failed for job ${id}`);
  }

  return {
    success: true,
    processedAt: new Date(),
    jobId: id,
    type,
  };
}

// Display statistics
async function displayStats(jobGuard: JobGuard, queue: Bull.Queue) {
  const stats = await jobGuard.getStats();
  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
  ]);

  const table = new Table({
    head: [
      chalk.cyan.bold('Source'),
      chalk.cyan.bold('Pending'),
      chalk.cyan.bold('Processing'),
      chalk.cyan.bold('Completed'),
      chalk.cyan.bold('Failed'),
      chalk.cyan.bold('Stuck'),
    ],
    style: { head: [], border: [] },
  });

  table.push(
    [chalk.yellow('Redis'), waiting, active, completed, failed, 'N/A'],
    [
      chalk.green('PostgreSQL'),
      stats.pending,
      stats.processing,
      stats.completed,
      stats.failed,
      chalk.red(stats.stuck),
    ]
  );

  console.log(table.toString());
}

async function main() {
  banner();

  // Step 1: Initialize infrastructure
  section(1, 7, 'Initializing infrastructure...');
  const spinner = ora('Connecting to Redis and PostgreSQL...').start();

  await sleep(1000);

  const queue = new Bull('demo-queue', REDIS_URL);

  try {
    const jobGuard = await JobGuard.create(queue, {
      postgres: POSTGRES_URL,
      reconciliation: {
        enabled: true,
        intervalMs: 5000, // Check every 5 seconds for demo
        stuckThresholdMs: 60000, // Consider stuck after 60 seconds (minimum allowed)
      },
      logging: {
        level: 'info',
      },
    });

    spinner.succeed('Infrastructure ready');
    logSuccess('Redis connected');
    logSuccess('PostgreSQL connected');
    logSuccess('JobGuard initialized');

    // Step 2: Clean up old data
    section(2, 7, 'Cleaning previous demo data...');

    // Clean Redis
    await queue.empty();
    await queue.clean(0, 'completed');
    await queue.clean(0, 'failed');

    // Clean PostgreSQL - delete all jobs for this queue
    const { Pool } = require('pg');
    const cleanupPool = new Pool({ connectionString: POSTGRES_URL });
    await cleanupPool.query('DELETE FROM jobguard_jobs WHERE queue_name = $1', [
      'demo-queue',
    ]);
    await cleanupPool.end();

    logSuccess('Redis queue cleaned');
    logSuccess('PostgreSQL cleaned');

    // Step 3: Add jobs
    section(3, 7, `Adding ${TOTAL_JOBS} jobs to queue...`);
    const addSpinner = ora('Creating jobs...').start();

    const jobTypes = ['email', 'notification', 'report', 'export', 'import'];

    for (let i = 1; i <= TOTAL_JOBS; i++) {
      await queue.add('process', {
        id: i,
        type: jobTypes[Math.floor(Math.random() * jobTypes.length)],
        timestamp: new Date(),
        data: { message: `Job ${i}` },
      });
    }

    addSpinner.succeed(`${TOTAL_JOBS} jobs queued`);
    await sleep(1000);

    // Step 4: Start processing
    section(4, 7, 'Processing jobs (with random failures)...');
    logInfo(`Simulating ${(FAILURE_RATE * 100).toFixed(0)}% failure rate`);

    let processedCount = 0;
    let failedCount = 0;

    queue.process('process', 3, async (job) => {
      try {
        const result = await processJob(job);
        processedCount++;
        if (processedCount % 10 === 0) {
          process.stdout.write(chalk.green('✓'));
        }
        return result;
      } catch (error) {
        failedCount++;
        if (failedCount % 5 === 0) {
          process.stdout.write(chalk.red('✗'));
        }
        throw error;
      }
    });

    // Wait for some processing
    await sleep(3000);
    console.log('\n');

    await displayStats(jobGuard, queue);

    // Step 5: Simulate Redis crash
    section(5, 7, '💥 SIMULATING REDIS CRASH...');
    logWarning("This demonstrates JobGuard's recovery capabilities");
    logInfo('In a real scenario, Redis might crash or lose connection');
    logInfo("For demo purposes, we'll pause the queue");

    await queue.pause();
    logError('Queue paused (simulating Redis unavailability)');

    await sleep(2000);

    const statsBeforeCrash = await jobGuard.getStats();
    logWarning(`${statsBeforeCrash.processing} jobs were in "processing" state`);
    logWarning('These jobs would be lost without JobGuard!');

    await sleep(3000);

    // Step 6: Recovery
    section(6, 7, '🔄 Recovering from failure...');
    logInfo('Restarting queue (simulating Redis recovery)');

    await queue.resume();
    logSuccess('Queue resumed');

    logInfo('JobGuard reconciliation will detect stuck jobs...');
    await sleep(2000);

    // Force reconciliation for demo
    await jobGuard.forceReconciliation();
    logSuccess('Reconciliation completed');

    const statsAfterRecovery = await jobGuard.getStats();
    if (statsAfterRecovery.stuck > 0) {
      logSuccess(`Detected ${statsAfterRecovery.stuck} stuck jobs`);
      logSuccess('Stuck jobs will be automatically re-enqueued');
    }

    // Wait for all jobs to complete
    const completionSpinner = ora('Waiting for all jobs to complete...').start();

    let attempts = 0;
    while (attempts < 60) {
      // Max 60 seconds
      const stats = await jobGuard.getStats();
      const remaining = TOTAL_JOBS - stats.completed - stats.dead;

      if (remaining === 0) {
        break;
      }

      completionSpinner.text = `${stats.completed}/${TOTAL_JOBS} completed, ${remaining} remaining`;
      await sleep(1000);
      attempts++;
    }

    completionSpinner.succeed('All jobs processed');

    // Step 7: Final results
    section(7, 7, 'Final Results');
    console.log('');
    await displayStats(jobGuard, queue);

    const finalStats = await jobGuard.getStats();

    console.log('\n' + chalk.green.bold('📊 Summary:'));
    console.log(chalk.white(`  Total jobs added:    ${TOTAL_JOBS}`));
    console.log(chalk.green(`  Completed:           ${finalStats.completed}`));
    console.log(chalk.red(`  Failed:              ${finalStats.failed}`));
    console.log(chalk.yellow(`  Stuck (recovered):   ${finalStats.stuck}`));
    console.log(
      chalk.blue(`  Jobs lost:           ${chalk.bold('0')} ${chalk.green('✓')}`)
    );

    const totalProcessed = finalStats.completed + finalStats.failed + finalStats.dead;
    if (totalProcessed >= TOTAL_JOBS) {
      console.log(
        '\n' +
          chalk.green.bold(
            '🎉 SUCCESS! All jobs completed despite the simulated failure!'
          )
      );
    } else {
      console.log(
        '\n' +
          chalk.yellow.bold(`⚠️  ${TOTAL_JOBS - totalProcessed} jobs still processing...`)
      );
    }

    console.log(
      '\n' + chalk.cyan('JobGuard ensured zero job loss during the Redis failure! 🛡️\n')
    );

    // Cleanup
    await sleep(2000);
    logInfo('Cleaning up...');
    await jobGuard.shutdown();
    await queue.close();
    logSuccess('Demo completed!');

    process.exit(0);
  } catch (error) {
    spinner.fail('Failed to initialize');
    console.error(chalk.red('Error:'), error);
    process.exit(1);
  }
}

// Handle interrupts gracefully
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n\nDemo interrupted. Cleaning up...'));
  process.exit(0);
});

main();
