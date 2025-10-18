import { Pool, PoolConfig } from 'pg';
import { PostgresConfig } from '../types/config';
import { PostgresConnectionError } from '../errors/errors';
import { Logger } from '../utils/logger';

export class ConnectionManager {
  private pool: Pool;
  private logger: Logger;
  private monitorInterval?: NodeJS.Timeout;
  private consecutiveExhaustionChecks = 0;
  private readonly MAX_EXHAUSTION_CHECKS = 3;
  private poolExhausted = false;

  constructor(config: PostgresConfig | string, logger: Logger) {
    this.logger = logger;
    this.pool = this.createPool(config);
    this.setupEventHandlers();
    this.startPoolMonitoring();
  }

  private createPool(config: PostgresConfig | string): Pool {
    const poolConfig: PoolConfig =
      typeof config === 'string'
        ? {
            connectionString: config,
            // Set query timeout to 30 seconds for all queries
            statement_timeout: 30000,
          }
        : {
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user,
            password: config.password,
            connectionString: config.connectionString,
            max: config.max || 10,
            idleTimeoutMillis: config.idleTimeoutMillis || 30000,
            connectionTimeoutMillis: config.connectionTimeoutMillis || 2000,
            // Set query timeout to 30 seconds for all queries
            statement_timeout: config.statement_timeout || 30000,
            ssl: config.ssl,
          };

    return new Pool(poolConfig);
  }

  private setupEventHandlers(): void {
    this.pool.on('error', (err) => {
      this.logger.error('Unexpected PostgreSQL pool error:', err);
    });

    this.pool.on('connect', () => {
      this.logger.debug('New PostgreSQL client connected');
    });

    this.pool.on('remove', () => {
      this.logger.debug('PostgreSQL client removed from pool');
    });
  }

  async testConnection(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      this.logger.info('PostgreSQL connection test successful');
    } catch (error) {
      this.logger.error('PostgreSQL connection test failed:', error);
      throw new PostgresConnectionError(
        'Failed to connect to PostgreSQL',
        error instanceof Error ? error : undefined
      );
    }
  }

  getPool(): Pool {
    return this.pool;
  }

  private startPoolMonitoring(): void {
    // Monitor pool health every 5 seconds
    this.monitorInterval = setInterval(() => {
      // Access pool internals - pg.Pool doesn't expose these types officially
      const pool = this.pool as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const stats = {
        total: (pool.totalCount as number) || 0,
        idle: (pool.idleCount as number) || 0,
        waiting: (pool.waitingCount as number) || 0,
      };

      // Warn if clients are waiting for connections
      if (stats.waiting > 0) {
        this.logger.warn(
          `Pool pressure detected: ${stats.waiting} clients waiting for connections`
        );
      }

      // Track pool exhaustion
      const maxSize = (pool.options?.max as number) || 10;
      const isExhausted = stats.idle === 0 && stats.total >= maxSize;

      if (isExhausted) {
        this.consecutiveExhaustionChecks++;

        if (this.consecutiveExhaustionChecks >= this.MAX_EXHAUSTION_CHECKS) {
          if (!this.poolExhausted) {
            this.poolExhausted = true;
            this.logger.error(
              `Pool critically exhausted! All ${stats.total} connections in use for ` +
                `${this.MAX_EXHAUSTION_CHECKS} consecutive checks (15 seconds). ` +
                `New operations will be rejected.`
            );
          }
        } else {
          this.logger.error(
            `Pool exhausted! All ${stats.total} connections in use. ` +
              `(${this.consecutiveExhaustionChecks}/${this.MAX_EXHAUSTION_CHECKS})`
          );
        }
      } else {
        // Reset exhaustion tracking when pool recovers
        if (this.consecutiveExhaustionChecks > 0 || this.poolExhausted) {
          this.logger.info(`Pool recovered. Idle: ${stats.idle}, Total: ${stats.total}`);
          this.consecutiveExhaustionChecks = 0;
          this.poolExhausted = false;
        }
      }

      // Debug log pool stats periodically
      this.logger.debug(
        `Pool stats - Total: ${stats.total}, Idle: ${stats.idle}, Waiting: ${stats.waiting}`
      );
    }, 5000);

    // Don't prevent process from exiting
    if (this.monitorInterval.unref) {
      this.monitorInterval.unref();
    }
  }

  /**
   * Check if pool is healthy and can accept new operations
   * @throws PostgresConnectionError if pool is critically exhausted
   */
  checkPoolHealth(): void {
    if (this.poolExhausted) {
      throw new PostgresConnectionError(
        'Connection pool is critically exhausted. All connections in use. ' +
          'Please reduce load or increase pool size.'
      );
    }
  }

  getPoolStats(): { total: number; idle: number; waiting: number } {
    // Access pool internals - pg.Pool doesn't expose these types officially
    const pool = this.pool as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      total: (pool.totalCount as number) || 0,
      idle: (pool.idleCount as number) || 0,
      waiting: (pool.waitingCount as number) || 0,
    };
  }

  async close(): Promise<void> {
    this.logger.info('Closing PostgreSQL connection pool');

    // Stop monitoring
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }

    await this.pool.end();
  }
}
