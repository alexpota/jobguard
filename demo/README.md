# JobGuard Demo

Interactive demonstrations of JobGuard's durability and recovery capabilities.

## Prerequisites

- Docker and Docker Compose
- Node.js 22+
- npm

## Quick Start

### 1. Start Infrastructure

```bash
docker-compose up -d
```

This starts:
- **PostgreSQL 14** on port 5433
- **Redis 7** on port 6379

### 2. Install Dependencies

```bash
npm install
```

### 3. Run a Demo

#### 🎯 Interactive Demo (Recommended)
50 jobs, visual progress, controlled Redis restart:
```bash
npm run demo
```

#### ⚡ Stress Test
10,000 jobs, 60 workers, chaos testing:
```bash
npm run stress
```

#### 💥 Chaos Test
Kills Redis 3 times during job processing:
```bash
npm run chaos
```

## What Each Demo Shows

### Interactive Demo (`npm run demo`)
- **Duration:** ~2 minutes
- **Jobs:** 50 across 3 queues (emails, payments, notifications)
- **Scenario:** Redis crash during processing
- **Visual:** Live progress bars and statistics
- **Key Learning:** Real-time reconciliation and recovery

### Stress Test (`npm run stress`)
- **Duration:** ~5 minutes
- **Jobs:** 10,000 across 3 queues
- **Workers:** 60 concurrent workers
- **Scenario:** Redis crash at peak load (60 jobs in-flight)
- **Key Learning:** Production-scale durability

### Chaos Test (`npm run chaos`)
- **Duration:** ~3 minutes
- **Jobs:** 1,000 total
- **Scenario:** Redis killed 3 times randomly
- **Key Learning:** Continuous resilience

## Expected Results

All demos should show:
- ✅ **Zero jobs lost** despite Redis crashes
- ✅ **Automatic recovery** when Redis restarts
- ✅ **Stuck job detection** and re-enqueue
- ✅ **Complete audit trail** in PostgreSQL

## Viewing PostgreSQL Data

While demos are running, inspect the database:

```bash
docker exec -it jobguard-postgres psql -U demo -d jobguard_demo

-- View all jobs
SELECT queue_name, status, COUNT(*)
FROM jobguard_jobs
GROUP BY queue_name, status;

-- View stuck jobs
SELECT job_id, queue_name, status, updated_at
FROM jobguard_jobs
WHERE status = 'stuck';

-- View job history
SELECT * FROM jobguard_jobs
ORDER BY created_at DESC
LIMIT 10;
```

## Troubleshooting

### "Connection refused" errors

Make sure Docker containers are running:
```bash
docker-compose ps
```

Both should show "Up" and "(healthy)":
```
NAME                 STATUS
jobguard-postgres    Up (healthy)
jobguard-redis       Up (healthy)
```

### Reset everything

```bash
docker-compose down -v
docker-compose up -d
npm install
```

## Demo Architecture

```
┌─────────────────┐
│  Demo Script    │
│  (Node.js)      │
└────────┬────────┘
         │
         ├──────────┐
         │          │
         ▼          ▼
    ┌────────┐  ┌──────────┐
    │ Redis  │  │PostgreSQL│
    │(queue) │  │(JobGuard)│
    └────────┘  └──────────┘
         ▲
         │
    Kill process
    (simulated crash)
```

## Cleanup

Stop and remove all containers:
```bash
docker-compose down -v
```

## Questions?

- See main [README](../README.md) for JobGuard documentation
- Report issues: [GitHub Issues](../../issues)
