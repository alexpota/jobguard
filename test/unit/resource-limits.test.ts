import { BaseAdapter } from '../../src/adapters/base.adapter';
import { JobRepository } from '../../src/persistence/repository';
import { Logger } from '../../src/utils/logger';
import { BullQueue } from '../../src/types/queue-types';

// Create a concrete test adapter
class TestAdapter extends BaseAdapter {
  readonly queueName = 'test-queue';
  readonly queueType = 'bull' as const;

  wrapAddMethod(): void {}
  attachEventListeners(): void {}
  async reEnqueueJob(): Promise<void> {}
}

describe('Resource Limit Validation', () => {
  let adapter: TestAdapter;
  let mockRepository: jest.Mocked<JobRepository>;
  let mockLogger: jest.Mocked<Logger>;
  let mockQueue: BullQueue;

  beforeEach(() => {
    mockRepository = {} as jest.Mocked<JobRepository>;
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    // Create a minimal mock queue
    mockQueue = {
      name: 'test-queue',
      client: {},
      add: jest.fn(),
      getJob: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn(),
    } as unknown as BullQueue;

    adapter = new TestAdapter(mockQueue, mockRepository, mockLogger);
  });

  describe('Job Name Length Validation', () => {
    it('should accept job names under 255 characters', () => {
      const validName = 'a'.repeat(255);
      const data = { test: 'data' };

      expect(() => {
        (adapter as any).validateJobData(validName, data);
      }).not.toThrow();
    });

    it('should reject job names exceeding 255 characters', () => {
      const invalidName = 'a'.repeat(256);
      const data = { test: 'data' };

      expect(() => {
        (adapter as any).validateJobData(invalidName, data);
      }).toThrow('Job name exceeds 255 characters');
    });

    it('should accept undefined job names', () => {
      const data = { test: 'data' };

      expect(() => {
        (adapter as any).validateJobData(undefined, data);
      }).not.toThrow();
    });

    it('should accept empty job names', () => {
      const data = { test: 'data' };

      expect(() => {
        (adapter as any).validateJobData('', data);
      }).not.toThrow();
    });
  });

  describe('Job Data Size Validation', () => {
    it('should accept data under 1MB', () => {
      // Create ~500KB of data
      const data = { payload: 'x'.repeat(500 * 1024) };

      expect(() => {
        (adapter as any).validateJobData('test-job', data);
      }).not.toThrow();
    });

    it('should reject data exceeding 1MB', () => {
      // Create ~1.5MB of data (accounting for JSON overhead)
      const data = { payload: 'x'.repeat(1.5 * 1024 * 1024) };

      expect(() => {
        (adapter as any).validateJobData('test-job', data);
      }).toThrow('Job data exceeds 1048576 bytes (1MB limit)');
    });

    it('should account for JSON stringification overhead', () => {
      // Create data that exceeds limit after JSON stringification
      // JSON adds quotes, colons, braces, etc.
      const data = {
        key: 'x'.repeat(1048550), // Over 1MB after JSON overhead
        nested: { foo: 'bar' },
      };

      expect(() => {
        (adapter as any).validateJobData('test', data);
      }).toThrow('Job data exceeds 1048576 bytes (1MB limit)');
    });

    it('should handle complex nested objects', () => {
      const data = {
        users: Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          name: `user-${i}`,
          email: `user${i}@example.com`,
        })),
      };

      // This should be well under 1MB
      expect(() => {
        (adapter as any).validateJobData('bulk-users', data);
      }).not.toThrow();
    });

    it('should handle arrays of large strings', () => {
      // Create array that pushes over 1MB
      const data = {
        items: Array.from({ length: 100 }, () => 'x'.repeat(15000)),
      };

      expect(() => {
        (adapter as any).validateJobData('large-array', data);
      }).toThrow('Job data exceeds 1048576 bytes (1MB limit)');
    });
  });

  describe('Combined Validation', () => {
    it('should validate both name and data together', () => {
      const validName = 'valid-job-name';
      const validData = { message: 'Hello World' };

      expect(() => {
        (adapter as any).validateJobData(validName, validData);
      }).not.toThrow();
    });

    it('should reject if name is invalid even with valid data', () => {
      const invalidName = 'x'.repeat(300);
      const validData = { message: 'Hello' };

      expect(() => {
        (adapter as any).validateJobData(invalidName, validData);
      }).toThrow('Job name exceeds 255 characters');
    });

    it('should reject if data is invalid even with valid name', () => {
      const validName = 'good-name';
      const invalidData = { huge: 'x'.repeat(2 * 1024 * 1024) };

      expect(() => {
        (adapter as any).validateJobData(validName, invalidData);
      }).toThrow('Job data exceeds 1048576 bytes (1MB limit)');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty data object', () => {
      expect(() => {
        (adapter as any).validateJobData('test', {});
      }).not.toThrow();
    });

    it('should handle null values in data', () => {
      const data = { value: null };

      expect(() => {
        (adapter as any).validateJobData('test', data);
      }).not.toThrow();
    });

    it('should handle unicode characters in job names', () => {
      const unicodeName = '🔥'.repeat(60); // Emojis are multiple bytes

      // Should count actual string length, not byte length
      expect(() => {
        (adapter as any).validateJobData(unicodeName, { test: 'data' });
      }).not.toThrow();
    });

    it('should handle unicode characters in data', () => {
      // Create data with enough unicode chars to exceed limit
      // JavaScript string length counts UTF-16 code units, not bytes
      const data = { message: '🔥'.repeat(600000) }; // Over 1MB in string length

      // Should reject based on string length
      expect(() => {
        (adapter as any).validateJobData('test', data);
      }).toThrow('Job data exceeds 1048576 bytes (1MB limit)');
    });
  });
});
