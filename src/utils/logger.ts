import { LoggingConfig } from '../types/config';

export class Logger {
  private enabled: boolean;
  private level: 'debug' | 'info' | 'warn' | 'error';
  private prefix: string;
  private levelPriority: Record<string, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(config: LoggingConfig = {}) {
    this.enabled = config.enabled !== false;
    this.level = config.level || 'info';
    this.prefix = config.prefix || '[JobGuard]';
  }

  private shouldLog(level: string): boolean {
    if (!this.enabled) return false;
    return (this.levelPriority[level] ?? 0) >= (this.levelPriority[this.level] ?? 0);
  }

  private formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    return `${timestamp} ${this.prefix} ${levelStr} ${message}`;
  }

  debug(message: string, ...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message), ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message), ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message), ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message), ...args);
    }
  }
}
