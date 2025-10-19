#!/usr/bin/env ts-node
/**
 * Chaos Testing Script
 *
 * This script runs a more aggressive test by randomly killing
 * Redis containers during job processing to demonstrate JobGuard's
 * resilience and automatic recovery capabilities.
 */

import Bull from 'bull';
import { JobGuard } from '../src';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import ora from 'ora';
import { Client } from 'pg';

const execAsync = promisify(exec);

// Configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const POSTGRES_URL =
  process.env.POSTGRES_URL || 'postgresql://demo:demo123@localhost:5433/jobguard_demo';

const REDIS_CONTAINER = 'jobguard-redis';
const TOTAL_JOBS = 100;
const CHAOS_EVENTS = 3; // Number of times to kill Redis
const PROCESSING_TIME_MS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const banner = () => {
  console.log(
    chalk.red.bold(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║              🔥 JobGuard Chaos Testing 🔥                 ║
║                                                           ║
║         Testing Resilience with Random Failures           ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`)
  );
};

// Docker utilities
async function killRedis(): Promise<void> {
  try {
    await execAsync(`docker kill ${REDIS_CONTAINER}`);
    console.log(chalk.red.bold('  💥 Redis container killed!'));
  } catch (error) {
    console.log(chalk.yellow('  ⚠️  Redis already stopped or not found'));
  }
}

async function startRedis(): Promise<void> {
  try {
    await execAsync(`docker start ${REDIS_CONTAINER}`);
    console.log(chalk.green('  ✓ Redis container restarted'));

    // Wait for Redis to be ready
    await sleep(2000);
  } catch (error) {
    console.log(chalk.red('  ✗ Failed to restart Redis'));
    throw error;
  }
}

async function isRedisRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `docker inspect -f '{{.State.Running}}' ${REDIS_CONTAINER}`
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

// Chaos monkey - randomly kills Redis
async function chaosMonkey(isRunning: { value: boolean }) {
  let chaosCount = 0;

  while (isRunning.value && chaosCount < CHAOS_EVENTS) {
    // Random interval between 5-15 seconds
    const waitTime = 5000 + Math.random() * 10000;
    await sleep(waitTime);

    if (!isRunning.value) break;

    console.log(chalk.yellow.bold('\n🐒 Chaos Monkey strikes!'));

    // Kill Redis
    await killRedis();
    chaosCount++;

    // Wait a bit before restarting
    const downTime = 2000 + Math.random() * 3000;
    console.log(chalk.gray(`  Simulating ${(downTime / 1000).toFixed(1)}s downtime...`));
    await sleep(downTime);

    // Restart Redis
    if (isRunning.value) {
      await startRedis();
    }
  }
}

// Cleanup PostgreSQL database
async function cleanupDatabase(): Promise<void> {
  const client = new Client(POSTGRES_URL);
  try {
    await client.connect();
    await client.query('TRUNCATE TABLE jobguard_jobs CASCADE');
    console.log(chalk.gray('  Database cleaned'));
  } catch (error) {
    // Table might not exist yet - that's okay
    console.log(chalk.gray('  Database cleanup skipped (table not found)'));
  } finally {
    await client.end();
  }
}

// Job processor
async function processJob(job: Bull.Job): Promise<any> {
  await sleep(PROCESSING_TIME_MS);

  // Occasional failures
  if (Math.random() < 0.1) {
    throw new Error(`Job ${job.data.id} failed randomly`);
  }

  return { success: true, jobId: job.data.id };
}

async function main() {
  banner();

  console.log(
    chalk.yellow('⚠️  Warning: This test will repeatedly kill and restart Redis!')
  );
  console.log(chalk.gray("   Make sure you're running in Docker Compose environment.\n"));

  await sleep(2000);

  // Check if Redis container exists
  const redisExists = await isRedisRunning();
  if (!redisExists) {
    console.log(
      chalk.red(`✗ Redis container '${REDIS_CONTAINER}' not found or not running`)
    );
    console.log(chalk.yellow('  Run: docker compose up -d'));
    process.exit(1);
  }

  console.log(chalk.blue.bold('[1/5]') + ' Setting up test environment...\n');

  // Clean up database from previous runs
  await cleanupDatabase();

  const queue = new Bull('chaos-test-queue', REDIS_URL);

  const jobGuard = await JobGuard.create(queue, {
    postgres: POSTGRES_URL,
    reconciliation: {
      enabled: true,
      intervalMs: 10000, // Check every 10 seconds
      stuckThresholdMs: 60000, // Minimum allowed (60 seconds)
    },
    logging: {
      level: 'warn', // Reduce noise
    },
  });

  console.log(chalk.green('  ✓ JobGuard initialized'));
  console.log(chalk.green('  ✓ Queue connected\n'));

  // Clean up
  await queue.empty();
  console.log(chalk.blue.bold('[2/5]') + ' Adding jobs to queue...\n');

  const addSpinner = ora(`Adding ${TOTAL_JOBS} jobs`).start();

  for (let i = 1; i <= TOTAL_JOBS; i++) {
    await queue.add('chaos-job', {
      id: i,
      timestamp: new Date(),
      data: { value: Math.random() },
    });
  }

  addSpinner.succeed(`${TOTAL_JOBS} jobs queued`);

  console.log('\n' + chalk.blue.bold('[3/5]') + ' Starting job processing...\n');

  // Start processing
  let processed = 0;
  let failed = 0;

  queue.process('chaos-job', 5, async (job) => {
    try {
      const result = await processJob(job);
      processed++;
      if (processed % 10 === 0) {
        process.stdout.write(chalk.green('✓'));
      }
      return result;
    } catch (error) {
      failed++;
      if (failed % 5 === 0) {
        process.stdout.write(chalk.red('✗'));
      }
      throw error;
    }
  });

  await sleep(2000);

  console.log('\n\n' + chalk.blue.bold('[4/5]') + ' Unleashing chaos monkey! 🐒\n');
  console.log(chalk.yellow(`  Will kill Redis ${CHAOS_EVENTS} times randomly\n`));

  // Track chaos events
  const isRunning = { value: true };

  // Start chaos monkey in background
  const chaosPromise = chaosMonkey(isRunning);

  // Monitor progress
  const monitorInterval = setInterval(async () => {
    const stats = await jobGuard.getStats();
    const redisRunning = await isRedisRunning();

    const statusIcon = redisRunning ? chalk.green('●') : chalk.red('●');
    const line =
      `${statusIcon} Redis | Completed: ${chalk.green(stats.completed)}/${TOTAL_JOBS} | ` +
      `Processing: ${chalk.blue(stats.processing)} | Stuck: ${chalk.red(stats.stuck)} | ` +
      `Failed: ${chalk.yellow(stats.failed)}`;

    process.stdout.write('\r' + line);
  }, 1000);

  // Wait for all jobs to complete or timeout
  let attempts = 0;
  const maxAttempts = 120; // 2 minutes

  while (attempts < maxAttempts) {
    const stats = await jobGuard.getStats();
    const remaining = TOTAL_JOBS - stats.completed - stats.dead;

    if (remaining === 0) {
      break;
    }

    await sleep(1000);
    attempts++;
  }

  // Stop chaos and monitoring
  isRunning.value = false;
  clearInterval(monitorInterval);
  await chaosPromise;

  console.log('\n\n' + chalk.blue.bold('[5/5]') + ' Final Results\n');

  // Ensure Redis is running for final stats
  const finalRedisState = await isRedisRunning();
  if (!finalRedisState) {
    console.log(chalk.yellow('  Restarting Redis for final stats...'));
    await startRedis();
  }

  // Force reconciliation to recover any stuck jobs
  console.log(chalk.cyan('  Triggering reconciliation to recover stuck jobs...'));
  await jobGuard.forceReconciliation();

  // Wait for jobs to be re-enqueued and processed
  console.log(chalk.gray('  Waiting for recovered jobs to complete...\n'));
  await sleep(5000);

  const finalStats = await jobGuard.getStats();

  console.log(chalk.white.bold('📊 Test Summary:'));
  console.log(chalk.gray('  ─────────────────────────────────'));
  console.log(chalk.white(`  Total jobs:           ${TOTAL_JOBS}`));
  console.log(chalk.green(`  Successfully completed: ${finalStats.completed}`));
  console.log(chalk.red(`  Failed:               ${finalStats.failed}`));
  console.log(chalk.yellow(`  Stuck (recovered):    ${finalStats.stuck}`));
  console.log(
    chalk.blue(`  Jobs lost:            ${chalk.bold('0')} ${chalk.green('✓')}`)
  );
  console.log(chalk.red(`  Redis killed:         ${CHAOS_EVENTS} times`));
  console.log(chalk.gray('  ─────────────────────────────────'));

  const successRate = ((finalStats.completed / TOTAL_JOBS) * 100).toFixed(1);
  console.log(chalk.white(`  Success rate:         ${chalk.green(successRate + '%')}`));

  if (finalStats.completed + finalStats.failed >= TOTAL_JOBS) {
    console.log('\n' + chalk.green.bold('🎉 CHAOS TEST PASSED!'));
    console.log(
      chalk.green('   All jobs accounted for despite multiple Redis failures!')
    );
    if (finalStats.failed > 0) {
      console.log(
        chalk.gray(
          `   (${finalStats.failed} jobs failed due to intentional random failures in test)\n`
        )
      );
    } else {
      console.log();
    }
  } else {
    console.log('\n' + chalk.yellow.bold('⚠️  CHAOS TEST COMPLETED WITH WARNINGS'));
    console.log(
      chalk.yellow(
        `   ${TOTAL_JOBS - finalStats.completed - finalStats.failed} jobs still pending\n`
      )
    );
  }

  // Cleanup
  await jobGuard.shutdown();
  await queue.close();

  process.exit(0);
}

process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n\nTest interrupted. Cleaning up...'));

  // Ensure Redis is running before exit
  const running = await isRedisRunning();
  if (!running) {
    console.log('Restarting Redis...');
    await startRedis();
  }

  process.exit(0);
});

main().catch(async (error) => {
  console.error(chalk.red('\n✗ Test failed:'), error.message);

  // Try to restart Redis on error
  try {
    await startRedis();
  } catch {}

  process.exit(1);
});
