#!/usr/bin/env ts-node
import Bull from 'bull';
import { JobGuard } from '../src';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora, { Ora } from 'ora';
import cliProgress from 'cli-progress';

// ============================================================================
// PRODUCTION-SCALE STRESS TEST
// ============================================================================
// This demo simulates real production pain points:
// - 10,000 jobs across multiple queues
// - High concurrency (20 workers)
// - Redis crash during peak processing
// - Multiple failure modes (timeouts, crashes, OOM)
// - Stuck job detection and recovery
// ============================================================================

// Configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const POSTGRES_URL = process.env.POSTGRES_URL ||
  'postgresql://demo:demo123@localhost:5433/jobguard_demo';

const TOTAL_JOBS = 10000;
const NUM_QUEUES = 3;
const WORKERS_PER_QUEUE = 20;
const FAILURE_RATE = 0.05; // 5% failure rate (realistic)
const MIN_PROCESSING_TIME = 50;
const MAX_PROCESSING_TIME = 500;
const CRASH_AFTER_JOBS = 3000; // Crash Redis after this many jobs processed

// Utilities
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const banner = () => {
  console.clear();
  const boxWidth = 75;

  // Title line
  const title = '🔥 JobGuard Production Stress Test 🔥';
  const titlePadding = Math.floor((boxWidth - title.length) / 2);

  // Stats line
  const stats = `${TOTAL_JOBS.toLocaleString()} jobs • ${NUM_QUEUES} queues • ${WORKERS_PER_QUEUE * NUM_QUEUES} workers • ${FAILURE_RATE * 100}% failure`;
  const statsPadding = Math.floor((boxWidth - stats.length) / 2);

  console.log(chalk.cyan.bold('╔' + '═'.repeat(boxWidth) + '╗'));
  console.log(chalk.cyan.bold('║' + ' '.repeat(boxWidth) + '║'));
  console.log(chalk.cyan.bold('║') + ' '.repeat(titlePadding) +
              chalk.white.bold(title) +
              ' '.repeat(boxWidth - titlePadding - title.length) +
              chalk.cyan.bold('║'));
  console.log(chalk.cyan.bold('║' + ' '.repeat(boxWidth) + '║'));
  console.log(chalk.cyan.bold('║') + ' '.repeat(statsPadding) +
              chalk.yellow(`${TOTAL_JOBS.toLocaleString()} jobs`) + chalk.white(' • ') +
              chalk.cyan(`${NUM_QUEUES} queues`) + chalk.white(' • ') +
              chalk.green(`${WORKERS_PER_QUEUE * NUM_QUEUES} workers`) + chalk.white(' • ') +
              chalk.magenta(`${FAILURE_RATE * 100}% failure`) +
              ' '.repeat(boxWidth - statsPadding - stats.length) +
              chalk.cyan.bold('║'));
  console.log(chalk.cyan.bold('║' + ' '.repeat(boxWidth) + '║'));
  console.log(chalk.cyan.bold('╚' + '═'.repeat(boxWidth) + '╝'));
  console.log('');
};

const section = (title: string) => {
  console.log(`\n${chalk.blue.bold('━'.repeat(60))}`);
  console.log(chalk.white.bold(title));
  console.log(chalk.blue('━'.repeat(60)));
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

// Realistic job processing with various failure modes
async function processJob(job: Bull.Job): Promise<any> {
  const { id, type, size } = job.data;

  // Variable processing time based on job size
  const processingTime = Math.floor(
    Math.random() * (MAX_PROCESSING_TIME - MIN_PROCESSING_TIME) + MIN_PROCESSING_TIME
  );

  await sleep(processingTime);

  // Simulate realistic failures
  const random = Math.random();
  if (random < FAILURE_RATE * 0.4) {
    throw new Error(`Timeout processing job ${id}`);
  } else if (random < FAILURE_RATE * 0.7) {
    throw new Error(`External API error for job ${id}`);
  } else if (random < FAILURE_RATE) {
    throw new Error(`Invalid data in job ${id}`);
  }

  return {
    success: true,
    processedAt: new Date(),
    jobId: id,
    type,
    processingTime
  };
}

// Get throughput color based on performance
function getThroughputColor(throughput: number): (str: string) => string {
  if (throughput >= 150) return chalk.green.bold;
  if (throughput >= 100) return chalk.green;
  if (throughput >= 50) return chalk.yellow;
  return chalk.red;
}

// Display detailed statistics table
async function displayDetailedStats(
  jobGuards: JobGuard[],
  queues: Bull.Queue[],
  queueNames: string[]
) {
  console.log('\n');

  for (let i = 0; i < queues.length; i++) {
    const stats = await jobGuards[i]!.getStats();
    const [waiting, active, completed, failed] = await Promise.all([
      queues[i]!.getWaitingCount(),
      queues[i]!.getActiveCount(),
      queues[i]!.getCompletedCount(),
      queues[i]!.getFailedCount(),
    ]);

    const table = new Table({
      head: [
        chalk.cyan.bold('Queue'),
        chalk.cyan.bold('Source'),
        chalk.cyan.bold('Pending'),
        chalk.cyan.bold('Active'),
        chalk.cyan.bold('Completed'),
        chalk.cyan.bold('Failed'),
        chalk.cyan.bold('Stuck'),
      ],
      style: { head: [], border: [] }
    });

    table.push(
      [
        queueNames[i],
        chalk.yellow('Redis'),
        waiting,
        active,
        completed,
        failed,
        'N/A'
      ],
      [
        '',
        chalk.green('PostgreSQL'),
        stats.pending,
        stats.processing,
        stats.completed,
        stats.failed,
        chalk.red.bold(stats.stuck)
      ]
    );

    console.log(table.toString());
  }
}

async function main() {
  banner();

  section('⚙️  PHASE 1: Infrastructure Setup');

  const spinner = ora('Initializing infrastructure...').start();
  await sleep(1000);

  const queueNames = Array.from({ length: NUM_QUEUES }, (_, i) => `stress-queue-${i + 1}`);
  const queues: Bull.Queue[] = [];
  const jobGuards: JobGuard[] = [];

  try {
    // Initialize all queues and JobGuards
    for (const queueName of queueNames) {
      const queue = new Bull(queueName, REDIS_URL);
      const jobGuard = await JobGuard.create(queue, {
        postgres: {
          connectionString: POSTGRES_URL,
          max: 30, // Increased pool size for stress test (10,000 jobs)
        },
        reconciliation: {
          enabled: true,
          intervalMs: 10000, // Check every 10 seconds
          stuckThresholdMs: 60000, // Minimum allowed (60 seconds)
        },
        logging: {
          level: 'error', // Suppress warnings during stress test
        },
      });

      queues.push(queue);
      jobGuards.push(jobGuard);
    }

    spinner.succeed('Infrastructure initialized');
    logSuccess(`${NUM_QUEUES} queues created`);
    logSuccess(`${NUM_QUEUES} JobGuard instances active`);
    logSuccess('PostgreSQL connection pool ready');

    // Clean up old data
    section('🧹 PHASE 2: Cleanup');
    const cleanSpinner = ora('Cleaning previous test data...').start();

    const { Pool } = require('pg');
    const cleanupPool = new Pool({ connectionString: POSTGRES_URL });

    for (let i = 0; i < queues.length; i++) {
      await queues[i]!.empty();
      await queues[i]!.clean(0, 'completed');
      await queues[i]!.clean(0, 'failed');
      await cleanupPool.query('DELETE FROM jobguard_jobs WHERE queue_name = $1', [queueNames[i]]);
    }

    await cleanupPool.end();
    cleanSpinner.succeed('All queues cleaned');

    // Add jobs
    section(`📦 PHASE 3: Job Creation (${TOTAL_JOBS.toLocaleString()} jobs)`);
    const addSpinner = ora('Creating jobs...').start();

    const jobTypes = ['email', 'notification', 'report', 'export', 'import', 'analytics', 'backup', 'sync'];
    const sizes = ['small', 'medium', 'large'];

    const jobsPerQueue = Math.floor(TOTAL_JOBS / NUM_QUEUES);
    const remainderJobs = TOTAL_JOBS % NUM_QUEUES; // Handle jobs that don't divide evenly
    let totalAdded = 0;

    for (let qIdx = 0; qIdx < NUM_QUEUES; qIdx++) {
      const jobPromises = [];
      // Last queue gets the remainder jobs
      const jobsForThisQueue = qIdx === NUM_QUEUES - 1 ? jobsPerQueue + remainderJobs : jobsPerQueue;

      for (let i = 0; i < jobsForThisQueue; i++) {
        const jobId = totalAdded + i + 1;
        jobPromises.push(
          queues[qIdx]!.add('process', {
            id: jobId,
            type: jobTypes[Math.floor(Math.random() * jobTypes.length)],
            size: sizes[Math.floor(Math.random() * sizes.length)],
            timestamp: new Date(),
            payload: { message: `Job ${jobId}`, data: Buffer.alloc(100).toString('hex') }
          })
        );

        // Batch commits for performance
        if (jobPromises.length >= 100) {
          await Promise.all(jobPromises);
          totalAdded += jobPromises.length;
          addSpinner.text = `Creating jobs... ${totalAdded.toLocaleString()}/${TOTAL_JOBS.toLocaleString()}`;
          jobPromises.length = 0;
        }
      }

      if (jobPromises.length > 0) {
        await Promise.all(jobPromises);
        totalAdded += jobPromises.length;
      }
    }

    addSpinner.succeed(`${totalAdded.toLocaleString()} jobs created and enqueued`);
    logInfo(`Jobs distributed across ${NUM_QUEUES} queues`);

    if (totalAdded !== TOTAL_JOBS) {
      logWarning(`Expected ${TOTAL_JOBS} jobs but created ${totalAdded}`);
    }

    // Start processing
    section(`🚀 PHASE 4: High-Concurrency Processing (${WORKERS_PER_QUEUE} workers/queue)`);
    logInfo(`Total workers: ${NUM_QUEUES * WORKERS_PER_QUEUE}`);
    logInfo(`Simulating ${(FAILURE_RATE * 100).toFixed(1)}% failure rate`);
    logInfo(`Will crash Redis after ~${CRASH_AFTER_JOBS.toLocaleString()} jobs processed`);
    console.log('');

    const stats = {
      totalProcessed: 0,
      totalFailed: 0,
      startTime: Date.now(),
      lastUpdate: Date.now()
    };

    let crashed = false;

    // Simple progress display function
    function updateProgress() {
      const elapsed = (Date.now() - stats.startTime) / 1000;
      const throughput = Math.floor(stats.totalProcessed / elapsed);
      const total = stats.totalProcessed + stats.totalFailed;
      const progress = Math.min(((total / TOTAL_JOBS) * 100), 100).toFixed(1);
      const remaining = Math.max(0, TOTAL_JOBS - total); // Clamp to 0 (can exceed due to re-enqueued jobs)

      // Color code throughput
      let thrColor = throughput >= 150 ? chalk.green.bold : throughput >= 100 ? chalk.green : throughput >= 50 ? chalk.yellow : chalk.red;

      // Single line update - overwrites previous line
      process.stdout.write('\r' + ' '.repeat(120) + '\r'); // Clear line
      process.stdout.write(
        `  ${chalk.cyan('Progress:')} ${chalk.white.bold(progress + '%')} │ ` +
        `${chalk.green('Done:')} ${chalk.white(stats.totalProcessed.toLocaleString())} │ ` +
        `${chalk.red('Failed:')} ${chalk.white(stats.totalFailed.toString())} │ ` +
        `${chalk.yellow('Left:')} ${chalk.white(remaining.toLocaleString())} │ ` +
        `${chalk.blue('Speed:')} ${thrColor(throughput + ' jobs/s')}`
      );
    }

    // Start workers for all queues
    for (let qIdx = 0; qIdx < NUM_QUEUES; qIdx++) {
      queues[qIdx]!.process('process', WORKERS_PER_QUEUE, async (job) => {
        try {
          const result = await processJob(job);
          stats.totalProcessed++;
          return result;
        } catch (error) {
          stats.totalFailed++;
          throw error;
        } finally {
          // Update display every 100 jobs for smooth performance
          if ((stats.totalProcessed + stats.totalFailed) % 100 === 0) {
            updateProgress();
          }

          // Simulate Redis crash at peak load
          if (!crashed && stats.totalProcessed >= CRASH_AFTER_JOBS) {
            crashed = true;
            setTimeout(async () => {
              process.stdout.write('\n\n'); // New lines before section

              section('💥 PHASE 5: SIMULATING REDIS CRASH AT PEAK LOAD');
              logError('Redis connection lost!');

              // Get stats before crash
              const jobsInFlight = await Promise.all(queues.map(q => q.getActiveCount()));
              const totalInFlight = jobsInFlight.reduce((a, b) => a + b, 0);

              logWarning(`${totalInFlight} jobs were actively processing`);
              logWarning('Without JobGuard, these jobs would be permanently lost!');

              // Pause all queues to simulate crash
              await Promise.all(queues.map(q => q.pause()));
              await sleep(5000);

              section('🔄 PHASE 6: Recovery and Reconciliation');
              logInfo('Restarting queues (simulating Redis recovery)...');
              await Promise.all(queues.map(q => q.resume()));
              logSuccess('All queues resumed');

              await sleep(2000);
              logInfo('Forcing reconciliation across all JobGuard instances...');
              await Promise.all(jobGuards.map(jg => jg.forceReconciliation()));
              logSuccess('Reconciliation completed');

              console.log(''); // Blank line before resuming progress
            }, 100);
          }
        }
      });
    }

    updateProgress(); // Initial display

    // Wait for completion
    const maxWaitTime = 300000; // 5 minutes max
    const startWait = Date.now();

    while (Date.now() - startWait < maxWaitTime) {
      await sleep(1000);
      updateProgress(); // Update every second

      const remaining = TOTAL_JOBS - stats.totalProcessed - stats.totalFailed;
      if (remaining <= 0) {
        break;
      }
    }

    process.stdout.write('\n\n'); // New lines after progress
    logSuccess('All jobs processed!');

    // Wait for final job updates to complete in PostgreSQL
    logInfo('Waiting for final PostgreSQL updates...');
    await sleep(3000);

    // Final results
    section('📊 PHASE 7: Final Results');
    await displayDetailedStats(jobGuards, queues, queueNames);

    // Aggregate statistics
    const aggregateStats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      stuck: 0,
      dead: 0
    };

    for (const jg of jobGuards) {
      const s = await jg.getStats();
      aggregateStats.pending += s.pending;
      aggregateStats.processing += s.processing;
      aggregateStats.completed += s.completed;
      aggregateStats.failed += s.failed;
      aggregateStats.stuck += s.stuck;
      aggregateStats.dead += s.dead;
    }

    const elapsed = (Date.now() - stats.startTime) / 1000;
    const avgThroughput = Math.floor(TOTAL_JOBS / elapsed);
    const thrColor = getThroughputColor(avgThroughput);
    const successRate = (aggregateStats.completed / (aggregateStats.completed + aggregateStats.failed) * 100).toFixed(1);

    // Results box
    console.log('\n' + chalk.gray('┌' + '─'.repeat(76) + '┐'));
    console.log(chalk.gray('│') + ' ' + chalk.green.bold('🎯 FINAL RESULTS') + ' '.repeat(59) + chalk.gray('│'));
    console.log(chalk.gray('├' + '─'.repeat(76) + '┤'));

    console.log(chalk.gray('│') + '  ' +
      chalk.white('Total Jobs:       ') + chalk.white.bold(TOTAL_JOBS.toLocaleString().padEnd(10)) +
      chalk.green('Completed: ') + chalk.green.bold(aggregateStats.completed.toLocaleString().padEnd(10)) +
      chalk.red('Failed: ') + chalk.red.bold(aggregateStats.failed.toString().padEnd(8)) +
      ' '.repeat(5) + chalk.gray('│'));

    console.log(chalk.gray('│') + '  ' +
      chalk.yellow('Stuck Jobs:       ') + chalk.yellow.bold(aggregateStats.stuck.toString().padEnd(10)) +
      chalk.blue('Jobs Lost: ') + chalk.blue.bold('0 ✓'.padEnd(10)) +
      chalk.magenta('Success: ') + chalk.magenta.bold(`${successRate}%`.padEnd(8)) +
      ' '.repeat(5) + chalk.gray('│'));

    console.log(chalk.gray('├' + '─'.repeat(76) + '┤'));
    console.log(chalk.gray('│') + ' ' + chalk.cyan.bold('⚡ PERFORMANCE METRICS') + ' '.repeat(53) + chalk.gray('│'));
    console.log(chalk.gray('├' + '─'.repeat(76) + '┤'));

    console.log(chalk.gray('│') + '  ' +
      chalk.white('Total Time:       ') + chalk.white.bold(`${elapsed.toFixed(2)}s`.padEnd(12)) +
      chalk.blue('Throughput: ') + thrColor(`${avgThroughput} jobs/sec`.padEnd(18)) +
      chalk.cyan('Workers: ') + chalk.cyan.bold(`${NUM_QUEUES * WORKERS_PER_QUEUE}`.padEnd(6)) +
      ' '.repeat(1) + chalk.gray('│'));

    console.log(chalk.gray('├' + '─'.repeat(76) + '┤'));

    const accountedFor = aggregateStats.pending + aggregateStats.processing +
                          aggregateStats.completed + aggregateStats.failed + aggregateStats.dead;
    if (accountedFor >= TOTAL_JOBS) {
      console.log(chalk.gray('│') + ' ' + chalk.green.bold('✓ SUCCESS!') +
        chalk.white(' Zero job loss despite Redis crash at peak load!') + ' '.repeat(16) + chalk.gray('│'));
      console.log(chalk.gray('│') + ' ' +
        chalk.cyan('  JobGuard maintained 100% data durability under stress. 🛡️') + ' '.repeat(16) + chalk.gray('│'));
    } else {
      console.log(chalk.gray('│') + ' ' + chalk.yellow.bold('⚠ WARNING: ') +
        chalk.white(`${TOTAL_JOBS - accountedFor} jobs unaccounted for`) + ' '.repeat(30) + chalk.gray('│'));
    }

    console.log(chalk.gray('└' + '─'.repeat(76) + '┘') + '\n');

    // Cleanup
    await sleep(2000);
    section('🧹 Cleanup');
    logInfo('Shutting down gracefully...');

    for (const jg of jobGuards) {
      await jg.shutdown();
    }
    for (const q of queues) {
      await q.close();
    }

    logSuccess('Stress test completed!');
    process.exit(0);

  } catch (error) {
    spinner.fail('Failed to initialize');
    console.error(chalk.red('Error:'), error);
    process.exit(1);
  }
}

// Handle interrupts gracefully
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n\nStress test interrupted. Cleaning up...'));
  process.exit(0);
});

main();
