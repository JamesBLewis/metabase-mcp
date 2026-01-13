/**
 * Unit tests for response truncation utility
 */

import { describe, it, expect, vi } from 'vitest';

// Mock config before importing the module
vi.mock('../../src/config.js', () => ({
  config: {
    MAX_RESPONSE_CHARS: 1000, // Small limit for testing
    LOG_LEVEL: 'error',
  },
}));

// Import after mocking
import { truncateResponse } from '../../src/utils/responseTruncation.js';

describe('truncateResponse', () => {
  describe('when response is under limit', () => {
    it('should return data unchanged', () => {
      const data = { results: [1, 2, 3], meta: 'test' };
      const result = truncateResponse(data);

      expect(result.wasTruncated).toBe(false);
      expect(result.data).toEqual(data);
      expect(result.truncationInfo).toBeUndefined();
    });

    it('should handle arrays under limit', () => {
      const data = [1, 2, 3, 4, 5];
      const result = truncateResponse(data);

      expect(result.wasTruncated).toBe(false);
    });

    it('should handle primitives under limit', () => {
      const result = truncateResponse('short string');
      expect(result.wasTruncated).toBe(false);
    });
  });

  describe('when object response exceeds limit', () => {
    it('should truncate array field and add truncation info', () => {
      // Create data that exceeds 1000 chars
      const largeData = {
        results: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: `Item ${i}`,
          description: 'A'.repeat(50),
        })),
      };

      const result = truncateResponse(largeData, { responseType: 'search', arrayField: 'results' });

      expect(result.wasTruncated).toBe(true);
      expect(result.truncationInfo).toBeDefined();
      expect(result.truncationInfo!.was_truncated).toBe(true);
      expect(result.truncationInfo!.original_items).toBe(100);
      expect(result.truncationInfo!.returned_items).toBeLessThan(100);
      expect(result.truncationInfo!.guidance).toContain('truncated');

      // Check the data has truncation info embedded
      const resultData = result.data as any;
      expect(resultData._truncation_info).toBeDefined();
      expect(resultData.results.length).toBeLessThan(100);
    });

    it('should find arrays automatically if no arrayField specified', () => {
      const largeData = {
        data: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          value: 'A'.repeat(50),
        })),
      };

      const result = truncateResponse(largeData);

      expect(result.wasTruncated).toBe(true);
      const resultData = result.data as any;
      expect(resultData.data.length).toBeLessThan(100);
    });

    it('should prefer specified arrayField over common fields', () => {
      const largeData = {
        items: [1, 2, 3],
        customArray: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          value: 'A'.repeat(50),
        })),
      };

      const result = truncateResponse(largeData, { arrayField: 'customArray' });

      expect(result.wasTruncated).toBe(true);
      const resultData = result.data as any;
      expect(resultData.customArray.length).toBeLessThan(100);
      expect(resultData.items).toEqual([1, 2, 3]); // Unchanged
    });
  });

  describe('when top-level array exceeds limit', () => {
    it('should wrap array in object with truncation info', () => {
      const largeArray = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        data: 'A'.repeat(50),
      }));

      const result = truncateResponse(largeArray, { responseType: 'list' });

      expect(result.wasTruncated).toBe(true);
      const resultData = result.data as any;
      expect(resultData._truncation_info).toBeDefined();
      expect(resultData.items.length).toBeLessThan(100);
    });
  });

  describe('truncation guidance by response type', () => {
    const createLargeData = () => ({
      results: Array.from({ length: 100 }, (_, i) => ({
        id: i,
        data: 'A'.repeat(50),
      })),
    });

    it('should provide search-specific guidance', () => {
      const result = truncateResponse(createLargeData(), { responseType: 'search' });
      expect(result.truncationInfo!.guidance).toContain('search terms');
    });

    it('should provide list-specific guidance', () => {
      const result = truncateResponse(createLargeData(), { responseType: 'list' });
      expect(result.truncationInfo!.guidance).toContain('pagination');
    });

    it('should provide retrieve-specific guidance', () => {
      const result = truncateResponse(createLargeData(), { responseType: 'retrieve' });
      expect(result.truncationInfo!.guidance).toContain('fewer IDs');
    });

    it('should provide execute-specific guidance', () => {
      const result = truncateResponse(createLargeData(), { responseType: 'execute' });
      expect(result.truncationInfo!.guidance).toContain('export tool');
    });

    it('should provide generic guidance for other types', () => {
      const result = truncateResponse(createLargeData(), { responseType: 'other' });
      expect(result.truncationInfo!.guidance).toContain('truncated');
    });
  });
});
