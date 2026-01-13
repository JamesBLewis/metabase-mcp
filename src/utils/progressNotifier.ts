/**
 * Progress notification utility for long-running MCP operations
 * Sends periodic notifications to keep Claude Desktop sessions alive
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * Options for progress notifications
 */
export interface ProgressNotifierOptions {
  /** Description of the operation being performed */
  operation: string;
  /** Interval between progress updates in milliseconds (default: 30000) */
  intervalMs?: number;
}

/**
 * Progress notifier that sends periodic logging messages during long operations
 * Uses sendLoggingMessage() to send status updates that keep the session alive
 */
export class ProgressNotifier {
  private server: Server;
  private operation: string;
  private intervalMs: number;
  private intervalId: NodeJS.Timeout | null = null;
  private startTime: number = 0;
  private updateCount: number = 0;

  constructor(server: Server, options: ProgressNotifierOptions) {
    this.server = server;
    this.operation = options.operation;
    this.intervalMs = options.intervalMs ?? 30000; // 30 seconds default
  }

  /**
   * Start sending progress notifications
   * Sends an initial notification and then periodic updates
   */
  start(): void {
    this.startTime = Date.now();
    this.updateCount = 0;

    // Send initial notification
    this.sendProgress('started');

    // Start periodic updates
    this.intervalId = setInterval(() => {
      this.updateCount++;
      const elapsed = Math.round((Date.now() - this.startTime) / 1000);
      this.sendProgress(`in progress (${elapsed}s elapsed)`);
    }, this.intervalMs);
  }

  /**
   * Stop sending progress notifications
   * @param status - Final status ('completed' or 'failed')
   */
  stop(status: 'completed' | 'failed'): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    this.sendProgress(`${status} (${elapsed}s total)`);
  }

  /**
   * Send a progress notification via logging message
   */
  private sendProgress(status: string): void {
    try {
      // Use sendLoggingMessage which is a built-in method on Server
      // This sends a notifications/message to the client
      this.server.sendLoggingMessage({
        level: 'info',
        logger: 'metabase-mcp',
        data: `${this.operation}: ${status}`,
      });
    } catch {
      // Silently ignore notification failures - don't let them affect the operation
    }
  }
}

/**
 * Helper function to wrap an async operation with progress notifications
 *
 * @param server - The MCP server instance
 * @param operation - Description of the operation
 * @param fn - The async function to execute
 * @returns The result of the async function
 */
export async function withProgress<T>(
  server: Server,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const progress = new ProgressNotifier(server, { operation });

  try {
    progress.start();
    const result = await fn();
    progress.stop('completed');
    return result;
  } catch (error) {
    progress.stop('failed');
    throw error;
  }
}
