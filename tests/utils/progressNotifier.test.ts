/**
 * Unit tests for progress notifier utility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressNotifier, withProgress } from '../../src/utils/progressNotifier.js';

describe('ProgressNotifier', () => {
  let mockServer: any;
  let notifier: ProgressNotifier;

  beforeEach(() => {
    vi.useFakeTimers();
    mockServer = {
      sendLoggingMessage: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start', () => {
    it('should send initial notification', () => {
      notifier = new ProgressNotifier(mockServer, { operation: 'Test operation' });
      notifier.start();

      expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith({
        level: 'info',
        logger: 'metabase-mcp',
        data: 'Test operation: started',
      });
    });

    it('should send periodic updates', () => {
      notifier = new ProgressNotifier(mockServer, {
        operation: 'Test operation',
        intervalMs: 1000,
      });
      notifier.start();

      // Initial notification
      expect(mockServer.sendLoggingMessage).toHaveBeenCalledTimes(1);

      // Advance 1 second
      vi.advanceTimersByTime(1000);
      expect(mockServer.sendLoggingMessage).toHaveBeenCalledTimes(2);
      expect(mockServer.sendLoggingMessage).toHaveBeenLastCalledWith({
        level: 'info',
        logger: 'metabase-mcp',
        data: 'Test operation: in progress (1s elapsed)',
      });

      // Advance another 2 seconds
      vi.advanceTimersByTime(2000);
      expect(mockServer.sendLoggingMessage).toHaveBeenCalledTimes(4);
    });

    it('should use default interval of 30 seconds', () => {
      notifier = new ProgressNotifier(mockServer, { operation: 'Test' });
      notifier.start();

      expect(mockServer.sendLoggingMessage).toHaveBeenCalledTimes(1);

      // Advance 29 seconds - should not trigger another update
      vi.advanceTimersByTime(29000);
      expect(mockServer.sendLoggingMessage).toHaveBeenCalledTimes(1);

      // Advance 1 more second to hit 30s
      vi.advanceTimersByTime(1000);
      expect(mockServer.sendLoggingMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('stop', () => {
    it('should send completion notification', () => {
      notifier = new ProgressNotifier(mockServer, { operation: 'Test operation' });
      notifier.start();
      mockServer.sendLoggingMessage.mockClear();

      notifier.stop('completed');

      expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith({
        level: 'info',
        logger: 'metabase-mcp',
        data: expect.stringContaining('Test operation: completed'),
      });
    });

    it('should send failure notification', () => {
      notifier = new ProgressNotifier(mockServer, { operation: 'Test operation' });
      notifier.start();
      mockServer.sendLoggingMessage.mockClear();

      notifier.stop('failed');

      expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith({
        level: 'info',
        logger: 'metabase-mcp',
        data: expect.stringContaining('Test operation: failed'),
      });
    });

    it('should stop interval timer', () => {
      notifier = new ProgressNotifier(mockServer, {
        operation: 'Test',
        intervalMs: 1000,
      });
      notifier.start();
      notifier.stop('completed');
      mockServer.sendLoggingMessage.mockClear();

      // Advance time - should not trigger more updates
      vi.advanceTimersByTime(5000);
      expect(mockServer.sendLoggingMessage).not.toHaveBeenCalled();
    });

    it('should include elapsed time in final message', () => {
      notifier = new ProgressNotifier(mockServer, { operation: 'Test' });
      notifier.start();

      // Advance 5 seconds
      vi.advanceTimersByTime(5000);
      notifier.stop('completed');

      expect(mockServer.sendLoggingMessage).toHaveBeenLastCalledWith({
        level: 'info',
        logger: 'metabase-mcp',
        data: 'Test: completed (5s total)',
      });
    });
  });

  describe('error handling', () => {
    it('should not throw if sendLoggingMessage fails', () => {
      mockServer.sendLoggingMessage.mockImplementation(() => {
        throw new Error('Network error');
      });

      notifier = new ProgressNotifier(mockServer, { operation: 'Test' });

      expect(() => notifier.start()).not.toThrow();
      expect(() => notifier.stop('completed')).not.toThrow();
    });
  });
});

describe('withProgress', () => {
  let mockServer: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockServer = {
      sendLoggingMessage: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should wrap async function with progress notifications', async () => {
    const asyncFn = vi.fn().mockResolvedValue('result');

    const resultPromise = withProgress(mockServer, 'Test operation', asyncFn);

    // Initial notification should be sent
    expect(mockServer.sendLoggingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: 'Test operation: started',
      })
    );

    const result = await resultPromise;

    expect(result).toBe('result');
    expect(mockServer.sendLoggingMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.stringContaining('Test operation: completed'),
      })
    );
  });

  it('should stop progress and rethrow on error', async () => {
    const error = new Error('Test error');
    const asyncFn = vi.fn().mockRejectedValue(error);

    await expect(withProgress(mockServer, 'Test operation', asyncFn)).rejects.toThrow('Test error');

    expect(mockServer.sendLoggingMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.stringContaining('Test operation: failed'),
      })
    );
  });

  it('should return function result', async () => {
    const asyncFn = vi.fn().mockResolvedValue({ data: [1, 2, 3] });

    const result = await withProgress(mockServer, 'Test', asyncFn);

    expect(result).toEqual({ data: [1, 2, 3] });
  });
});
