# JobGuard Examples

This directory contains practical examples demonstrating different JobGuard features and use cases.

## Prerequisites

Make sure you have PostgreSQL and Redis running locally:

```bash
# Using Docker (recommended)
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:14
docker run -d -p 6379:6379 redis:7

# Or use the demo environment
cd ../demo
docker compose up -d
```

Create the database and schema:

```bash
# Create database
createdb jobguard_dev

# Apply schema
psql -d jobguard_dev -f ../schema/001_initial.sql
```

## Running Examples

```bash
# Install dependencies (from project root)
npm install

# Run any example
npx tsx examples/basic-usage.ts
npx tsx examples/multiple-queues.ts
npx tsx examples/long-running-jobs-heartbeat.ts
```

## Available Examples

### 1. Basic Usage (`basic-usage.ts`)

**Learn**: Core JobGuard integration

Demonstrates the fundamental setup:
- Creating a queue with JobGuard
- Adding jobs
- Processing jobs
- Monitoring statistics
- Graceful shutdown

**Best for**: Getting started with JobGuard

**Run time**: ~30 seconds

---

### 2. Multiple Queues (`multiple-queues.ts`)

**Learn**: Managing multiple independent queues

Shows how to:
- Set up JobGuard for multiple queues
- Configure different settings per queue
- Monitor multiple queues independently
- Coordinate shutdown across queues

**Use case**: Applications with different job types (emails, payments, notifications)

**Run time**: ~30 seconds

---

### 3. Long-Running Jobs with Heartbeat (`long-running-jobs-heartbeat.ts`) ⭐ **NEW**

**Learn**: Handling jobs with dynamic/long execution times

Demonstrates:
- Setting up heartbeat mechanism for long-running jobs
- Using short stuck threshold (5 min) with heartbeat
- Processing jobs ranging from 10 seconds to 10+ minutes
- Simulating crash recovery with heartbeats
- Automatic heartbeat management with `setInterval`

**Problem solved**:
- Without heartbeat: Choose between slow recovery OR false positives
- With heartbeat: Fast recovery (5 min) AND no false positives

**Key insight**: Heartbeats allow a single `stuckThresholdMs` to work for both quick (20s) and slow (2 hours) jobs!

**Run time**: ~12 minutes (includes crash recovery demo)

**Features showcased**:
```typescript
// Setup heartbeat (every 30 seconds)
const heartbeat = setInterval(async () => {
  await jobGuard.updateHeartbeat(job.id!);
}, 30000);

try {
  // Your long-running work
  await processLargeDataset();
} finally {
  clearInterval(heartbeat); // Always clean up!
}
```

**Best for**:
- Data processing pipelines
- Report generation
- File uploads/downloads
- Database migrations
- Any job with unpredictable duration

---

## Example Comparison

| Example | Duration | Jobs | Complexity | Features |
|---------|----------|------|------------|----------|
| **basic-usage** | 30s | 5 short jobs | ⭐ Simple | Core setup, monitoring |
| **multiple-queues** | 30s | 3 queues | ⭐⭐ Medium | Multi-queue, different configs |
| **long-running-jobs-heartbeat** | 12min | 4 dynamic jobs | ⭐⭐⭐ Advanced | Heartbeats, crash recovery |

## Tips

1. **Start with `basic-usage.ts`** to understand core concepts
2. **Use `long-running-jobs-heartbeat.ts`** if your jobs take >5 minutes or have variable durations
3. **Study `multiple-queues.ts`** for production architectures with different job types

## Common Patterns

### Pattern 1: Short Jobs (< 5 minutes)
```typescript
// No heartbeat needed
const jobGuard = await JobGuard.create(queue, {
  postgres: postgresUrl,
  reconciliation: {
    stuckThresholdMs: 300000, // 5 minutes
  },
});
```

### Pattern 2: Long or Dynamic Jobs
```typescript
// Use heartbeat for reliability
const jobGuard = await JobGuard.create(queue, {
  postgres: postgresUrl,
  reconciliation: {
    stuckThresholdMs: 300000, // 5 min - fast recovery!
  },
});

// In worker
queue.process(async (job) => {
  const heartbeat = setInterval(
    () => jobGuard.updateHeartbeat(job.id),
    30000
  );

  try {
    await longRunningTask(job.data);
  } finally {
    clearInterval(heartbeat);
  }
});
```

### Pattern 3: Mixed Workload
```typescript
// Use separate queues
const fastQueue = new Queue('fast-jobs', redis);
const fastGuard = await JobGuard.create(fastQueue, {
  postgres: postgresUrl,
  reconciliation: { stuckThresholdMs: 300000 }, // 5 min
});

const slowQueue = new Queue('slow-jobs', redis);
const slowGuard = await JobGuard.create(slowQueue, {
  postgres: postgresUrl,
  reconciliation: { stuckThresholdMs: 7200000 }, // 2 hours
});
```

## Next Steps

- Read the [main README](../README.md) for full documentation
- Explore the [interactive demo](../demo/README.md) for stress testing
- Check [API Reference](../README.md#api-reference) for all methods

## Questions?

- [Report Issues](https://github.com/alexpota/jobguard/issues)
- [Read Documentation](../README.md)
