# JobGuard

[![npm version](https://img.shields.io/npm/v/jobguard.svg)](https://www.npmjs.com/package/jobguard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)

PostgreSQL durability for Redis-backed job queues (Bull, BullMQ, Bee-Queue) with minimal integration.

## Table of Contents

- [Why JobGuard?](#why-jobguard)
- [Demo](#-demo)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Database Setup](#database-setup)
- [Advanced Usage](#advanced-usage)
- [API Reference](#api-reference)
- [Queue Library Support](#queue-library-support)
- [How It Works](#how-it-works)
- [Performance](#performance-considerations)
- [Known Limitations](#known-limitations)
- [Security](#security)
- [Requirements](#requirements)
- [FAQ](#faq)
- [License](#license)
- [Contributing](#contributing)

## Why JobGuard?

Redis-backed queues are fast but **volatile**. When Redis crashes or restarts, you lose:

- ❌ Jobs currently being processed
- ❌ Jobs waiting in the queue
- ❌ Job history and audit trail
- ❌ Ability to recover stuck jobs

**JobGuard solves this** by adding PostgreSQL durability as a safety net, without changing your existing queue code.

### The Problem: Speed vs Safety Trade-off

Most teams face this dilemma:

| Option | Result |
|--------|--------|
| Use Redis-only queues (Bull/BullMQ/Bee-Queue) | ⚡ Fast but lose jobs on crash |
| Use PostgreSQL-only queues | 🛡️ Safe but sacrifice Redis speed |
| Configure Redis AOF persistence | ⚠️ Still can lose data + complex setup |

### The Solution: Best of Both Worlds

JobGuard lets you keep Redis speed **and** get PostgreSQL safety:

```typescript
// Your existing queue
const queue = new Bull('my-queue', 'redis://localhost:6379');

// Add JobGuard (just 3 lines)
const jobGuard = await JobGuard.create(queue, {
  postgres: 'postgresql://localhost:5432/mydb',
});

// That's it! Your queue now has 100% durability
```

### Stress Test Results

**Benchmark** (10,000 jobs, 60 workers, Redis crash at peak load):

- 🎯 **Zero jobs lost** - 100% recovery after crash
- 🛡️ **100% durability** - Every job persisted to PostgreSQL
- ⏱️ **55 seconds** - Full stress test with crash recovery
- 📊 **60 concurrent workers** - Proven scalability under load

[▶️ Run the interactive stress test yourself](./demo#readme)

### Choose JobGuard If You:

- ✅ Already use Bull/BullMQ/Bee-Queue and want to keep Redis performance
- ✅ Need 100% durability without rewriting existing queue code
- ✅ Want automatic recovery from Redis crashes
- ✅ Need to support multiple queue libraries in one codebase
- ✅ Want minimal integration effort (3 lines of code)

## 🎬 Demo

![JobGuard Stress Test](./assets/demo.gif)

✅ **10,000 jobs • 60 workers • Redis crash at peak load • Zero jobs lost**

[▶️ Run the interactive demo yourself →](./demo#readme)

## Features

- 🔒 **Drop-In Integration**: Wraps existing queues without modifying your queue code
- 🔄 **Automatic Recovery**: Client-side reconciliation detects and recovers stuck jobs
- 💓 **Heartbeat Support**: Long-running jobs signal liveness for accurate stuck detection
- 📊 **Multi-Queue Support**: Works with Bull, BullMQ, and Bee-Queue
- ⚡ **Low Overhead**: <5ms per job operation, minimal memory footprint
- 🛡️ **Fault Tolerant**: Circuit breaker pattern protects against PostgreSQL failures
- 🎯 **Type Safe**: Full TypeScript support with strict typing

## Quick Start

### Installation

```bash
npm install jobguard pg
```

### Basic Usage

```typescript
import Bull from 'bull';
import { JobGuard } from 'jobguard';

// Create your queue as usual
const queue = new Bull('my-queue', 'redis://localhost:6379');

// Add JobGuard for durability
const jobGuard = await JobGuard.create(queue, {
  postgres: 'postgresql://localhost:5432/mydb',
});

// Use your queue normally - JobGuard works transparently
await queue.add('email', { to: 'user@example.com' });

// Gracefully shutdown when done
process.on('SIGTERM', async () => {
  await jobGuard.shutdown();
  await queue.close();
});
```

## Configuration

### Full Configuration Example

```typescript
const jobGuard = await JobGuard.create(queue, {
  // PostgreSQL connection (required)
  postgres: {
    host: 'localhost',
    port: 5432,
    database: 'mydb',
    user: 'postgres',
    password: 'secret',
    max: 10, // Connection pool size
    ssl: false,
  },

  // Or use connection string
  // postgres: 'postgresql://localhost:5432/mydb',

  // Reconciliation settings (optional)
  reconciliation: {
    enabled: true,
    intervalMs: 30000, // Check every 30 seconds
    stuckThresholdMs: 300000, // 5 minutes (minimum: 60000ms)
    maxAttempts: 3,
    batchSize: 100,
    adaptiveScheduling: true, // Adjust interval based on load
    rateLimitPerSecond: 20, // Max jobs to re-enqueue per second (default: 20)
  },

  // Logging settings (optional)
  logging: {
    enabled: true,
    level: 'info', // 'debug' | 'info' | 'warn' | 'error'
    prefix: '[JobGuard]',
  },

  // Persistence settings (optional)
  persistence: {
    retentionDays: 7, // Keep completed jobs for 7 days
    cleanupEnabled: true,
    cleanupIntervalMs: 3600000, // Cleanup every hour
  },
});
```

## Database Setup

**One-time setup:** Create the JobGuard table in your PostgreSQL database.

### Option 1: Using psql (Recommended)

```bash
psql -d mydb -f node_modules/jobguard/schema/001_initial.sql
```

### Option 2: Programmatically

```typescript
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

const pool = new Pool({ connectionString: 'postgresql://localhost:5432/mydb' });
const schema = readFileSync(
  join(__dirname, 'node_modules/jobguard/schema/001_initial.sql'),
  'utf8'
);
await pool.query(schema);
```

### Option 3: Add to Your Existing Migrations

Copy `node_modules/jobguard/schema/001_initial.sql` into your project's migration system (Knex, TypeORM, Prisma, etc.).

## Advanced Usage

### Force Reconciliation

Trigger immediate reconciliation:

```typescript
await jobGuard.forceReconciliation();
```

### Get Queue Statistics

```typescript
const stats = await jobGuard.getStats();
console.log(`
  Queue: ${stats.queueName}
  Pending: ${stats.pending}
  Processing: ${stats.processing}
  Completed: ${stats.completed}
  Failed: ${stats.failed}
  Stuck: ${stats.stuck}
  Total: ${stats.total}
`);
```

### Multiple Queues

```typescript
const emailQueue = new Bull('emails', redisUrl);
const emailGuard = await JobGuard.create(emailQueue, { postgres: postgresUrl });

const paymentQueue = new Bull('payments', redisUrl);
const paymentGuard = await JobGuard.create(paymentQueue, { postgres: postgresUrl });

// Each queue is tracked independently
```

### Heartbeat for Long-Running Jobs

**Problem**: For jobs with dynamic or long execution times (e.g., 20 seconds to 2 hours), a fixed `stuckThresholdMs` can cause false positives or slow recovery.

**Solution**: Use heartbeats to signal that a job is still alive, regardless of how long it runs.

```typescript
import { Worker } from 'bullmq';
import { JobGuard } from 'jobguard';

const queue = new Queue('data-sync', { connection: { host: 'localhost' } });
const jobGuard = await JobGuard.create(queue, {
  postgres: postgresUrl,
  reconciliation: {
    stuckThresholdMs: 300000, // 5 minutes - short threshold works with heartbeats!
  },
});

// Worker: Update heartbeat every 30 seconds during long-running jobs
const worker = new Worker('data-sync', async (job) => {
  const heartbeatInterval = setInterval(async () => {
    await jobGuard.updateHeartbeat(job.id!);
  }, 30000); // Update every 30 seconds

  try {
    // Your long-running job logic
    for (let i = 0; i < largeDataset.length; i++) {
      await processItem(largeDataset[i]);
      // Heartbeat automatically updates in the background
    }
  } finally {
    clearInterval(heartbeatInterval);
  }
}, { connection: { host: 'localhost' } });
```

**How it works**:
- `updateHeartbeat(jobId)` updates the `last_heartbeat` timestamp in PostgreSQL
- Stuck detection uses `COALESCE(last_heartbeat, updated_at)` - falls back to `updated_at` if no heartbeat
- With regular heartbeats, jobs can run for hours without being marked stuck
- If a worker crashes mid-heartbeat, the job is detected as stuck within `stuckThresholdMs` (fast recovery!)

**Benefits**:
- ✅ Fast recovery (5 minutes) for crashed jobs
- ✅ No false positives for long-running jobs
- ✅ Works with dynamic job durations (20 sec to 2 hours)
- ✅ Backward compatible (jobs without heartbeats fall back to `updated_at`)

## API Reference

### `JobGuard.create(queue, config)`

Creates and initializes a new JobGuard instance.

**Parameters:**
- `queue` **(required)** - Bull, BullMQ, or Bee-Queue instance
- `config` **(required)** - Configuration object

**Returns:** `Promise<JobGuard>`

**Example:**
```typescript
const jobGuard = await JobGuard.create(queue, {
  postgres: 'postgresql://localhost:5432/mydb'
});
```

### `jobGuard.getStats()`

Retrieves current queue statistics from PostgreSQL.

**Returns:** `Promise<JobStats>`

**JobStats interface:**
```typescript
{
  queueName: string;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  stuck: number;
  dead: number;
  total: number;
}
```

### `jobGuard.forceReconciliation()`

Manually triggers immediate reconciliation of stuck jobs.

**Returns:** `Promise<void>`

### `jobGuard.updateHeartbeat(jobId)`

Updates the heartbeat timestamp for a processing job to indicate it's still alive.

**Parameters:**
- `jobId` **(required)** - The job ID to update (string or number)

**Returns:** `Promise<void>`

**Example:**
```typescript
// In your worker process
const worker = new Worker('my-queue', async (job) => {
  const heartbeat = setInterval(() => {
    await jobGuard.updateHeartbeat(job.id);
  }, 30000); // Every 30 seconds

  try {
    await longRunningTask(job.data);
  } finally {
    clearInterval(heartbeat);
  }
});
```

**Notes:**
- Only updates heartbeat for jobs in `processing` status
- Silently fails if job is not found or not processing (doesn't throw)
- Recommended heartbeat interval: 30-60 seconds for most workloads

### `jobGuard.shutdown()`

Gracefully shuts down JobGuard, stopping reconciliation and closing database connections.

**Returns:** `Promise<void>`

**Example:**
```typescript
process.on('SIGTERM', async () => {
  await jobGuard.shutdown();
  await queue.close();
});
```

### Configuration Types

For full TypeScript type definitions and configuration options, see:
- [Configuration Types](./src/types/config.ts)
- [Job Types](./src/types/job.ts)

## Queue Library Support

### Bull

```typescript
import Bull from 'bull';
import { JobGuard } from 'jobguard';

const queue = new Bull('my-queue', 'redis://localhost:6379');
const guard = await JobGuard.create(queue, { postgres: postgresUrl });
```

### BullMQ

```typescript
import { Queue } from 'bullmq';
import { JobGuard } from 'jobguard';

const queue = new Queue('my-queue', { connection: { host: 'localhost' } });
const guard = await JobGuard.create(queue, { postgres: postgresUrl });
```

### Bee-Queue

```typescript
import Queue from 'bee-queue';
import { JobGuard } from 'jobguard';

const queue = new Queue('my-queue', { redis: { host: 'localhost' } });
const guard = await JobGuard.create(queue, { postgres: postgresUrl });
```

## How It Works

JobGuard provides durability through three mechanisms:

1. **Job Tracking**: Intercepts job creation and tracks jobs in PostgreSQL
2. **Event Monitoring**: Listens to queue events to update job status
3. **Reconciliation**: Periodically checks for stuck jobs and re-enqueues them

### Architecture

![JobGuard Architecture](./assets/architecture.svg)

**How it works:**
1. **Queue Adapter** intercepts `queue.add()` and writes to both Redis (fast) and PostgreSQL (durable)
2. **Event Monitor** listens to queue events and updates job status in PostgreSQL
3. **Worker** (optional) sends heartbeats to PostgreSQL to signal long-running jobs are still alive
4. **Reconciler** runs every 30 seconds to detect stuck jobs (using heartbeat or last update time) and re-enqueue them to Redis

## Performance Considerations

- **Overhead**: <5ms per job operation
- **Memory**: <50MB for tracking 10,000 jobs
- **Database**: Uses connection pooling (default: 10 connections)
- **Reconciliation**: Adaptive scheduling reduces load during idle periods

## Error Handling

JobGuard uses a circuit breaker to prevent cascading failures:

```typescript
import { CircuitBreakerOpenError } from 'jobguard';

try {
  await jobGuard.getStats();
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    console.error('PostgreSQL is unavailable, circuit breaker is open');
  }
}
```

When PostgreSQL is unavailable, JobGuard logs errors but allows your queue to continue operating normally. Jobs will be reconciled once PostgreSQL recovers.

## Known Limitations

### Race Condition Scenarios

While JobGuard provides strong durability guarantees, some edge-case race conditions are **inherent to distributed systems** and cannot be completely eliminated:

#### 1. Worker Crash During Job Processing

**Scenario**: Worker processes a job successfully → crashes before sending completion event → reconciler re-enqueues the job

**Impact**: Job may be processed twice

**Mitigation**:
- Implement idempotent job handlers in your application
- Use database transactions or unique constraints for non-idempotent operations
- Monitor duplicate processing via PostgreSQL job history

#### 2. Bee-Queue Duplicate Jobs

**Scenario**: Bee-Queue generates new job IDs when re-enqueueing stuck jobs (architectural limitation)

**Impact**: Two job records exist in PostgreSQL (old marked 'failed', new marked 'pending')

**Why this happens**: Unlike Bull/BullMQ, Bee-Queue doesn't support custom job IDs

**Mitigation**:
- The old job is marked as 'failed' to prevent conflict with partial index constraint
- Only one job will be active in Redis at any time
- Consider using Bull or BullMQ if this is a concern

#### 3. Very Short-Lived Jobs

**Scenario**: Job completes in <100ms before event listeners attach

**Impact**: Job may be marked as 'stuck' initially, then corrected

**Mitigation**:
- Use `stuckThresholdMs: 300000` (5 minutes) to avoid false positives
- Very short jobs complete before reconciliation runs anyway

### Configuration Constraints

- **Minimum `stuckThresholdMs`**: 60,000ms (60 seconds) - prevents marking healthy jobs as stuck
- **Rate limiting**: Reconciliation re-enqueues at 20 jobs/second by default (configurable via `rateLimitPerSecond`)
- **Error message truncation**: Error messages are truncated to 5,000 characters and sanitized for security

### Multi-Instance Reconciliation

**⚠️ Not Supported**: Running multiple JobGuard instances with reconciliation enabled for the same queue can cause duplicate re-enqueue attempts.

**Best Practice**: Only enable reconciliation (`reconciliation.enabled: true`) on **one** instance per queue:

```typescript
// Worker instances - reconciliation disabled
const jobGuard = await JobGuard.create(queue, {
  postgres: postgresUrl,
  reconciliation: { enabled: false },
});

// Single orchestrator instance - reconciliation enabled
const jobGuard = await JobGuard.create(queue, {
  postgres: postgresUrl,
  reconciliation: { enabled: true },
});
```

### Performance Trade-offs

- **PostgreSQL overhead**: Each job operation adds ~5ms latency
- **Reconciliation impact**: Checking 10,000 stuck jobs takes ~2-5 seconds
- **Memory usage**: ~50MB for tracking 10,000 jobs

## Security

### Reporting Vulnerabilities

🔒 **Please do NOT open public issues for security vulnerabilities.**

If you discover a security issue, please **[Create a private security advisory](https://github.com/alexpota/jobguard/security/advisories/new)**

We will respond within 48 hours and work with you to address the issue.

### Best Practices

**Production Deployment:**
- ✅ Use SSL/TLS for PostgreSQL connections (`ssl: true`)
- ✅ Store connection strings in environment variables, not code
- ✅ Use least-privilege database user with only required permissions:
  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE ON jobguard_jobs TO jobguard_user;
  ```
- ✅ Rotate database credentials regularly
- ✅ Set appropriate `max_connections` for your PostgreSQL instance
- ✅ Enable PostgreSQL audit logging for compliance requirements

**What JobGuard Does NOT Do:**
- ❌ JobGuard does not encrypt job data at rest (use PostgreSQL encryption)
- ❌ JobGuard does not implement authentication (secure your PostgreSQL)
- ❌ JobGuard does not sanitize job data (validate in your application)

## Requirements

- **Node.js**: 22.0+ (LTS)
- **PostgreSQL**: 14+ (for B-tree deduplication)
- **Queue Library**: Bull 4.12+, BullMQ 5.1+, or Bee-Queue 1.7+

## FAQ

### Why PostgreSQL only? Can I use MySQL/MongoDB?

**No** - JobGuard currently requires PostgreSQL 14+.

JobGuard uses PostgreSQL-specific features that are difficult to replicate in other databases:

| Feature | Why It Matters | Other Databases |
|---------|----------------|-----------------|
| **JSONB** | Fast job data storage and queries without deserialization | MySQL JSON is slower; MongoDB has native JSON but lacks other features |
| **Partial Indexes** | Only indexes active jobs - reduces storage and improves performance | MySQL has limited support; MongoDB supports but lacks transactional guarantees |
| **ACID Transactions** | Guarantees zero data loss during writes | MongoDB added in 4.0 but still limited; MySQL supports but lacks JSONB |
| **Advanced Indexes** | B-tree deduplication (PostgreSQL 14+) reduces index size by ~40% | Not available in MySQL/MongoDB |

**Could other databases be supported?**

Supporting MySQL or MongoDB would require:
- Abstract database layer (adds complexity and maintenance burden)
- Different schema implementations for each database
- Performance compromises (MySQL's JSON is measurably slower than JSONB)
- Extensive testing across multiple database versions

This significantly increases complexity for a feature that most users don't need. PostgreSQL is widely adopted in the Node.js ecosystem and provides the best combination of performance, reliability, and features for job durability.

**What if my team uses MySQL/MongoDB?**

You have three options:

1. **Add PostgreSQL for job tracking only** - JobGuard uses a single table with minimal overhead. Many teams run PostgreSQL alongside their primary database specifically for features like job durability.

2. **Use PostgreSQL-only alternatives** - [Graphile Worker](https://github.com/graphile/worker) and [pg-boss](https://github.com/timgit/pg-boss) are PostgreSQL-native job queues (no Redis).

3. **Request MySQL support** - If there's significant demand, MySQL support may be considered in the future. [Open an issue](https://github.com/alexpota/jobguard/issues) to discuss your use case.

### Why not just use Redis persistence (RDB/AOF)?

Redis persistence has limitations that JobGuard addresses:

**Redis AOF with `appendfsync everysec` (recommended setting):**
- Can lose up to 1 second of data on crash
- Does not detect stuck jobs (worker crashes mid-processing)
- Requires manual recovery after Redis restarts

**Redis AOF with `appendfsync always` (100% durable):**
- Significantly slower (every write waits for disk fsync)
- Still doesn't detect stuck jobs
- Still requires manual intervention for recovery

**JobGuard provides:**
- Zero data loss (PostgreSQL ACID guarantees)
- Automatic stuck job detection and re-enqueueing
- Full job history and audit trail
- Minimal performance impact (~5ms overhead per job)

You can use Redis persistence AND JobGuard together for defense in depth, but JobGuard provides features that Redis persistence alone cannot.

## License

MIT

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for development setup, testing, and code guidelines.

---

**Built by [Alex Potapenko](https://github.com/alexpota) • [Report Issues](https://github.com/alexpota/jobguard/issues)**
