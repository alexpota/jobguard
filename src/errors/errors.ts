export class JobGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobGuardError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class UnsupportedQueueError extends JobGuardError {
  constructor(queueType: string) {
    super(`Unsupported queue type: ${queueType}`);
    this.name = 'UnsupportedQueueError';
  }
}

export class PostgresConnectionError extends JobGuardError {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(`PostgreSQL connection error: ${message}`);
    this.name = 'PostgresConnectionError';
  }
}

export class CircuitBreakerOpenError extends JobGuardError {
  constructor(circuitName: string) {
    super(`Circuit breaker is open for: ${circuitName}`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class ReconciliationError extends JobGuardError {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(`Reconciliation error: ${message}`);
    this.name = 'ReconciliationError';
  }
}
