import { CircuitBreaker } from '../../src/utils/circuit-breaker';
import { CircuitBreakerOpenError } from '../../src/errors/errors';

describe('CircuitBreaker', () => {
  it('should execute function when circuit is closed', async () => {
    const breaker = new CircuitBreaker({
      threshold: 3,
      timeout: 1000,
      name: 'test',
    });

    const fn = jest.fn().mockResolvedValue('success');
    const result = await breaker.execute(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should open circuit after threshold failures', async () => {
    const breaker = new CircuitBreaker({
      threshold: 3,
      timeout: 1000,
      name: 'test',
    });

    const fn = jest.fn().mockRejectedValue(new Error('failure'));

    // Fail 3 times
    await expect(breaker.execute(fn)).rejects.toThrow('failure');
    await expect(breaker.execute(fn)).rejects.toThrow('failure');
    await expect(breaker.execute(fn)).rejects.toThrow('failure');

    expect(breaker.getState()).toBe('open');

    // Next call should throw CircuitBreakerOpenError
    await expect(breaker.execute(fn)).rejects.toThrow(CircuitBreakerOpenError);
  });

  it('should transition to half-open after timeout', async () => {
    const breaker = new CircuitBreaker({
      threshold: 2,
      timeout: 100, // Short timeout for testing
      name: 'test',
    });

    const fn = jest.fn();
    fn.mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('success');

    // Open the circuit
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    expect(breaker.getState()).toBe('open');

    // Wait for timeout
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Should allow one attempt in half-open state
    const result = await breaker.execute(fn);
    expect(result).toBe('success');
    expect(breaker.getState()).toBe('closed');
  });

  it('should reset failure count on success', async () => {
    const breaker = new CircuitBreaker({
      threshold: 3,
      timeout: 1000,
      name: 'test',
    });

    const fn = jest.fn();
    fn.mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('success')
      .mockRejectedValueOnce(new Error('fail'));

    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    await breaker.execute(fn); // Success - resets count
    await expect(breaker.execute(fn)).rejects.toThrow('fail');

    // Should still be closed (only 1 failure after reset)
    expect(breaker.getState()).toBe('closed');
  });
});
