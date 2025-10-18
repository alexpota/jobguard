// Main exports
export { JobGuard } from './jobguard';

// Type exports
export type {
  JobGuardConfig,
  PostgresConfig,
  ReconciliationConfig,
  LoggingConfig,
  PersistenceConfig,
} from './types/config';

export type { JobRecord, JobStats } from './types/job';
export { JobStatus } from './types/job';

export type { QueueAdapter } from './types/adapter';

// Error exports
export {
  JobGuardError,
  UnsupportedQueueError,
  PostgresConnectionError,
  CircuitBreakerOpenError,
  ReconciliationError,
} from './errors/errors';
