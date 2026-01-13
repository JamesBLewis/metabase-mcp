/**
 * Response truncation utility for MCP responses
 * Ensures responses don't exceed token limits for AI context windows
 */

import { config } from '../config.js';

/**
 * Metadata about truncation applied to a response
 */
export interface TruncationInfo {
  was_truncated: boolean;
  original_size_chars: number;
  truncated_size_chars: number;
  original_items?: number;
  returned_items?: number;
  guidance: string;
}

/**
 * Context for truncation decisions
 */
export interface TruncationContext {
  /** The type of data being truncated (e.g., 'search', 'list', 'execute') */
  responseType?: 'search' | 'list' | 'retrieve' | 'execute' | 'other';
  /** Field name containing the array to truncate (e.g., 'results', 'data') */
  arrayField?: string;
}

/**
 * Result of truncation operation
 */
export interface TruncationResult {
  data: unknown;
  wasTruncated: boolean;
  truncationInfo?: TruncationInfo;
}

/**
 * Guidance messages for different response types
 */
const TRUNCATION_GUIDANCE: Record<string, string> = {
  search:
    'Response truncated due to size. Use more specific search terms or retrieve individual items by ID.',
  list: 'Response truncated due to size. Use pagination (offset/limit parameters) to retrieve remaining items.',
  retrieve:
    'Response truncated due to size. Request fewer IDs per batch or use more specific queries.',
  execute:
    'Response truncated due to size. Use the export tool for large datasets or add LIMIT to your SQL query.',
  other: 'Response truncated due to size. Try requesting less data or use pagination if available.',
};

/**
 * Find arrays in an object that can be truncated
 */
function findTruncatableArray(
  obj: Record<string, unknown>,
  preferredField?: string
): { field: string; array: unknown[] } | null {
  // If preferred field exists and is an array, use it
  if (preferredField && Array.isArray(obj[preferredField])) {
    return { field: preferredField, array: obj[preferredField] as unknown[] };
  }

  // Common array field names to look for
  const commonFields = ['results', 'data', 'items', 'rows', 'records'];
  for (const field of commonFields) {
    if (Array.isArray(obj[field])) {
      return { field, array: obj[field] as unknown[] };
    }
  }

  return null;
}

/**
 * Truncate an array to fit within character limit
 * Uses binary search to find optimal size efficiently
 */
function truncateArrayToFit(
  obj: Record<string, unknown>,
  arrayField: string,
  array: unknown[],
  maxChars: number
): { truncatedObj: Record<string, unknown>; originalCount: number; finalCount: number } {
  const originalCount = array.length;

  // Start with full array, reduce if needed
  let low = 1;
  let high = array.length;
  let bestFit = 1;

  // Binary search for optimal array size
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const testObj = { ...obj, [arrayField]: array.slice(0, mid) };
    const testSize = JSON.stringify(testObj).length;

    if (testSize <= maxChars) {
      bestFit = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const truncatedObj = { ...obj, [arrayField]: array.slice(0, bestFit) };
  return { truncatedObj, originalCount, finalCount: bestFit };
}

/**
 * Truncate a response to fit within the configured character limit
 *
 * @param data - The response data to potentially truncate
 * @param context - Optional context about the response type
 * @returns The (potentially truncated) data with truncation metadata
 */
export function truncateResponse(data: unknown, context?: TruncationContext): TruncationResult {
  const maxChars = config.MAX_RESPONSE_CHARS;
  const originalJson = JSON.stringify(data);
  const originalSize = originalJson.length;

  // If under limit, return unchanged
  if (originalSize <= maxChars) {
    return {
      data,
      wasTruncated: false,
    };
  }

  // Handle object responses (most common case)
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const truncatable = findTruncatableArray(obj, context?.arrayField);

    if (truncatable) {
      const { truncatedObj, originalCount, finalCount } = truncateArrayToFit(
        obj,
        truncatable.field,
        truncatable.array,
        maxChars - 500 // Reserve space for truncation info
      );

      const responseType = context?.responseType || 'other';
      const truncationInfo: TruncationInfo = {
        was_truncated: true,
        original_size_chars: originalSize,
        truncated_size_chars: JSON.stringify(truncatedObj).length,
        original_items: originalCount,
        returned_items: finalCount,
        guidance: TRUNCATION_GUIDANCE[responseType],
      };

      // Add truncation info to response
      const resultObj = {
        ...truncatedObj,
        _truncation_info: truncationInfo,
      };

      return {
        data: resultObj,
        wasTruncated: true,
        truncationInfo,
      };
    }
  }

  // Handle top-level array responses
  if (Array.isArray(data)) {
    const dummyObj = { items: data };
    const { truncatedObj, originalCount, finalCount } = truncateArrayToFit(
      dummyObj,
      'items',
      data,
      maxChars - 500
    );

    const responseType = context?.responseType || 'other';
    const truncationInfo: TruncationInfo = {
      was_truncated: true,
      original_size_chars: originalSize,
      truncated_size_chars: JSON.stringify(truncatedObj.items).length,
      original_items: originalCount,
      returned_items: finalCount,
      guidance: TRUNCATION_GUIDANCE[responseType],
    };

    // For array responses, wrap in object with truncation info
    const resultObj = {
      items: truncatedObj.items,
      _truncation_info: truncationInfo,
    };

    return {
      data: resultObj,
      wasTruncated: true,
      truncationInfo,
    };
  }

  // For other types (string, number, etc.) that exceed limit,
  // we can't meaningfully truncate, so return with warning
  const responseType = context?.responseType || 'other';
  const truncationInfo: TruncationInfo = {
    was_truncated: true,
    original_size_chars: originalSize,
    truncated_size_chars: originalSize, // Can't truncate primitive
    guidance: `${TRUNCATION_GUIDANCE[responseType]} (Response could not be truncated - consider a different query)`,
  };

  return {
    data: {
      _truncation_info: truncationInfo,
      _note: 'Response too large and could not be truncated. Please request less data.',
    },
    wasTruncated: true,
    truncationInfo,
  };
}
