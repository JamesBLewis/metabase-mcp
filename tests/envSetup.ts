/**
 * Environment setup for tests - runs before any test files or their imports
 * This file is specified in vitest.config.ts setupFiles
 *
 * IMPORTANT: This must be loaded before any imports that touch the config module
 */

// Set high MAX_RESPONSE_CHARS to disable truncation during tests
// The config module will read this when it's first imported
process.env.MAX_RESPONSE_CHARS = '10000000';
