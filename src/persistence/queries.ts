export const QUERIES = {
  INSERT_JOB: `
    INSERT INTO jobguard_jobs (
      queue_name, queue_type, job_id, job_name, data, status, attempts, max_attempts
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (queue_name, queue_type, job_id)
      WHERE status NOT IN ('completed', 'failed', 'dead')
    DO UPDATE SET
      data = EXCLUDED.data,
      status = EXCLUDED.status,
      attempts = EXCLUDED.attempts,
      updated_at = NOW()
    WHERE jobguard_jobs.status NOT IN ('completed', 'failed', 'dead')
    RETURNING *
  `,

  UPDATE_JOB_STATUS: `
    UPDATE jobguard_jobs
    SET status = $1::VARCHAR,
        updated_at = NOW(),
        started_at = CASE WHEN $1::VARCHAR = 'processing' THEN NOW() ELSE started_at END,
        last_heartbeat = CASE WHEN $1::VARCHAR = 'processing' THEN NOW() ELSE last_heartbeat END,
        completed_at = CASE WHEN $1::VARCHAR IN ('completed', 'failed', 'dead') THEN NOW() ELSE completed_at END
    WHERE queue_name = $2 AND queue_type = $3 AND job_id = $4
    RETURNING *
  `,

  UPDATE_JOB_ERROR: `
    UPDATE jobguard_jobs
    SET attempts = attempts + 1,
        error_message = $1,
        status = CASE
          WHEN attempts + 1 >= max_attempts THEN 'dead'::VARCHAR
          ELSE 'failed'::VARCHAR
        END,
        updated_at = NOW(),
        completed_at = CASE
          WHEN attempts + 1 >= max_attempts THEN NOW()
          ELSE completed_at
        END
    WHERE queue_name = $2 AND queue_type = $3 AND job_id = $4
    RETURNING *
  `,

  GET_STUCK_JOBS: `
    SELECT * FROM jobguard_jobs
    WHERE queue_name = $1
      AND status = 'processing'
      AND COALESCE(last_heartbeat, updated_at) < NOW() - INTERVAL '1 millisecond' * $2
    ORDER BY COALESCE(last_heartbeat, updated_at) ASC
    LIMIT $3
    FOR UPDATE SKIP LOCKED
  `,

  MARK_AS_STUCK: `
    UPDATE jobguard_jobs
    SET status = 'stuck', updated_at = NOW()
    WHERE id = ANY($1)
    RETURNING *
  `,

  DELETE_OLD_JOBS: `
    DELETE FROM jobguard_jobs
    WHERE status IN ('completed', 'failed', 'dead')
      AND completed_at < NOW() - INTERVAL '1 day' * $1
  `,

  GET_STATISTICS: `
    SELECT
      status,
      COUNT(*) as count
    FROM jobguard_jobs
    WHERE queue_name = $1
    GROUP BY status
  `,

  GET_JOB: `
    SELECT * FROM jobguard_jobs
    WHERE queue_name = $1 AND queue_type = $2 AND job_id = $3
  `,

  BULK_UPDATE_STATUS: `
    UPDATE jobguard_jobs
    SET status = $1::VARCHAR,
        updated_at = NOW()
    FROM unnest($2::uuid[]) AS job_ids(id)
    WHERE jobguard_jobs.id = job_ids.id
    RETURNING jobguard_jobs.*
  `,

  BULK_MARK_DEAD: `
    UPDATE jobguard_jobs
    SET status = 'dead'::VARCHAR,
        updated_at = NOW(),
        completed_at = NOW()
    FROM unnest($1::uuid[]) AS job_ids(id)
    WHERE jobguard_jobs.id = job_ids.id
    RETURNING jobguard_jobs.*
  `,

  UPDATE_HEARTBEAT: `
    UPDATE jobguard_jobs
    SET last_heartbeat = NOW()
    WHERE queue_name = $1 AND queue_type = $2 AND job_id = $3
      AND status = 'processing'
    RETURNING *
  `,
};
