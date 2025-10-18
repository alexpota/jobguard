export interface JobGuardConfig {
  postgres: PostgresConfig | string;
  reconciliation?: ReconciliationConfig;
  logging?: LoggingConfig;
  persistence?: PersistenceConfig;
  limits?: LimitsConfig;
}

export interface LimitsConfig {
  maxJobDataSize?: number; // Default: 1048576 (1MB)
  maxJobNameLength?: number; // Default: 255
}

export interface PostgresConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  connectionString?: string;
  max?: number; // Pool size (default: 10)
  idleTimeoutMillis?: number; // Default: 30000
  connectionTimeoutMillis?: number; // Default: 2000
  statement_timeout?: number; // Query timeout in ms (default: 30000)
  ssl?: boolean | object;
}

export interface ReconciliationConfig {
  enabled?: boolean; // Default: true
  intervalMs?: number; // Default: 30000
  stuckThresholdMs?: number; // Default: 300000 (5 minutes)
  batchSize?: number; // Default: 100
  adaptiveScheduling?: boolean; // Default: true
  rateLimitPerSecond?: number; // Default: 20 (jobs per second during re-enqueue)
  useHeartbeat?: boolean; // Default: true - Use last_heartbeat for stuck detection instead of updated_at
}

export interface LoggingConfig {
  enabled?: boolean; // Default: true
  level?: 'debug' | 'info' | 'warn' | 'error'; // Default: 'info'
  prefix?: string; // Default: '[JobGuard]'
}

export interface PersistenceConfig {
  retentionDays?: number; // Default: 7
  cleanupEnabled?: boolean; // Default: true
  cleanupIntervalMs?: number; // Default: 3600000 (1 hour)
}
