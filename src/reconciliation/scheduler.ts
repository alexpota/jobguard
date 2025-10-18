import { Logger } from '../utils/logger';

export interface SchedulerConfig {
  baseIntervalMs: number;
  adaptiveScheduling: boolean;
}

export class AdaptiveScheduler {
  private baseIntervalMs: number;
  private currentIntervalMs: number;
  private adaptiveScheduling: boolean;
  private logger: Logger;
  private consecutiveEmptyRuns = 0;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;

  constructor(config: SchedulerConfig, logger: Logger) {
    this.baseIntervalMs = config.baseIntervalMs;
    this.currentIntervalMs = config.baseIntervalMs;
    this.adaptiveScheduling = config.adaptiveScheduling;
    this.logger = logger;
    this.minIntervalMs = Math.max(5000, config.baseIntervalMs / 4);
    this.maxIntervalMs = config.baseIntervalMs * 4;
  }

  recordResult(foundStuckJobs: number, successRate = 1.0): void {
    if (!this.adaptiveScheduling) return;

    // If success rate is low, increase interval to back off
    if (successRate < 0.8) {
      this.currentIntervalMs = Math.min(this.currentIntervalMs * 1.5, this.maxIntervalMs);
      this.logger.warn(
        `Increased reconciliation interval to ${this.currentIntervalMs}ms ` +
          `due to low success rate (${(successRate * 100).toFixed(1)}%)`
      );
      return;
    }

    if (foundStuckJobs === 0) {
      this.consecutiveEmptyRuns++;
      // Gradually increase interval when no stuck jobs are found
      if (this.consecutiveEmptyRuns >= 3) {
        this.currentIntervalMs = Math.min(
          this.currentIntervalMs * 1.5,
          this.maxIntervalMs
        );
        this.logger.debug(
          `Increased reconciliation interval to ${this.currentIntervalMs}ms (no stuck jobs)`
        );
      }
    } else {
      this.consecutiveEmptyRuns = 0;
      // Decrease interval when stuck jobs are found and success rate is good
      this.currentIntervalMs = Math.max(this.currentIntervalMs * 0.8, this.minIntervalMs);
      this.logger.debug(
        `Decreased reconciliation interval to ${this.currentIntervalMs}ms ` +
          `(${foundStuckJobs} stuck jobs, ${(successRate * 100).toFixed(1)}% success)`
      );
    }
  }

  getCurrentInterval(): number {
    return Math.round(this.currentIntervalMs);
  }

  reset(): void {
    this.currentIntervalMs = this.baseIntervalMs;
    this.consecutiveEmptyRuns = 0;
  }
}
