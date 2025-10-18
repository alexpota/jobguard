-- Enable UUID extension if not exists
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Main table with optimized data types
CREATE TABLE IF NOT EXISTS jobguard_jobs (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    queue_name VARCHAR(100) NOT NULL,
    queue_type VARCHAR(20) NOT NULL CHECK (queue_type IN ('bull', 'bullmq', 'bee')),
    job_id VARCHAR(100) NOT NULL,
    job_name VARCHAR(100),
    data JSONB NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'stuck', 'dead')),
    attempts SMALLINT NOT NULL DEFAULT 0,
    max_attempts SMALLINT NOT NULL DEFAULT 3,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    last_heartbeat TIMESTAMPTZ
);

-- Unique constraint for active jobs only (saves space)
-- IMPORTANT: Must match the WHERE clause in INSERT_JOB query
CREATE UNIQUE INDEX idx_unique_active_job
    ON jobguard_jobs (queue_name, queue_type, job_id)
    WHERE status NOT IN ('completed', 'failed', 'dead');

-- Index for reconciliation queries (supports both heartbeat and updated_at detection)
CREATE INDEX idx_reconciliation_heartbeat
    ON jobguard_jobs (queue_name, status, last_heartbeat, updated_at)
    WHERE status IN ('processing', 'stuck');

-- Index for cleanup queries
CREATE INDEX idx_cleanup
    ON jobguard_jobs (completed_at)
    WHERE status IN ('completed', 'failed', 'dead');

-- Index for job lookups (including historical records)
CREATE INDEX idx_job_lookup
    ON jobguard_jobs (queue_name, queue_type, job_id);

-- Updated at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_jobguard_jobs_updated_at
    BEFORE UPDATE ON jobguard_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
