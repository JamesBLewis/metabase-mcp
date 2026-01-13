/**
 * JSON formatting utility for MCP responses
 */

import { config } from '../config.js';
import { truncateResponse, TruncationContext } from './responseTruncation.js';

/**
 * Formats a value as JSON string for MCP responses.
 * Uses compact format by default, pretty-printed when LOG_LEVEL=debug.
 *
 * @param data - The data to format as JSON
 * @returns JSON string (compact or pretty-printed based on LOG_LEVEL)
 */
export function formatJson(data: unknown): string {
  return config.LOG_LEVEL === 'debug' ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

/**
 * Formats a value as JSON string with automatic truncation if response exceeds size limit.
 * Applies truncation first, then formats as JSON.
 *
 * @param data - The data to format as JSON
 * @param context - Optional context about the response type for better truncation handling
 * @returns JSON string (potentially truncated, compact or pretty-printed based on LOG_LEVEL)
 */
export function formatJsonWithLimit(data: unknown, context?: TruncationContext): string {
  const { data: processedData } = truncateResponse(data, context);
  return formatJson(processedData);
}
