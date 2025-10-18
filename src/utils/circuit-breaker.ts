import { CircuitBreakerOpenError } from '../errors/errors';

export interface CircuitBreakerConfig {
  threshold: number; // Number of failures before opening
  timeout: number; // Time in ms to wait before attempting half-open
  name: string;
}

enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

export interface CircuitBreakerMetrics {
  state: string;
  failureCount: number;
  successCount: number;
  totalCalls: number;
  failureRate: number;
  lastFailureTime: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly threshold: number;
  private readonly timeout: number;
  private readonly name: string;
  private readonly windowMs: number = 60000; // 60 second sliding window
  private callHistory: Array<{ success: boolean; timestamp: number }> = [];

  constructor(config: CircuitBreakerConfig) {
    this.threshold = config.threshold;
    this.timeout = config.timeout;
    this.name = config.name;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.pruneOldCalls();

    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = CircuitState.HALF_OPEN;
      } else {
        throw new CircuitBreakerOpenError(this.name);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private pruneOldCalls(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.callHistory = this.callHistory.filter((call) => call.timestamp > cutoff);
  }

  private onSuccess(): void {
    const now = Date.now();
    this.callHistory.push({ success: true, timestamp: now });
    this.successCount++;
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
    }
  }

  private onFailure(): void {
    const now = Date.now();
    this.callHistory.push({ success: false, timestamp: now });
    this.failureCount++;
    this.lastFailureTime = now;

    if (this.failureCount >= this.threshold) {
      this.state = CircuitState.OPEN;
    }
  }

  getState(): string {
    return this.state;
  }

  getMetrics(): CircuitBreakerMetrics {
    this.pruneOldCalls();

    const windowFailures = this.callHistory.filter((call) => !call.success).length;
    const windowTotal = this.callHistory.length;

    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalCalls: windowTotal, // Total calls in current window
      failureRate: windowTotal > 0 ? (windowFailures / windowTotal) * 100 : 0,
      lastFailureTime: this.lastFailureTime,
    };
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.callHistory = [];
    this.lastFailureTime = 0;
  }
}
