/**
 * Shared HTTP session store for OAuth-authenticated sessions
 *
 * In HTTP mode, OAuth sessions are stored here and accessed by the API client.
 * This bridges the gap between the OAuth flow and the Metabase API client.
 */

// Map of access tokens to Metabase session tokens
const httpSessions = new Map<string, { metabaseToken: string; expiresAt: number }>();

// Track the most recent session for fallback (single-user scenarios)
let lastActiveSession: { metabaseToken: string; expiresAt: number } | null = null;

/**
 * Store a Metabase session token for an OAuth access token
 */
export function setHttpSession(
  accessToken: string,
  metabaseToken: string,
  expiresAt: number
): void {
  const session = { metabaseToken, expiresAt };
  httpSessions.set(accessToken, session);
  lastActiveSession = session;
}

/**
 * Get the Metabase session token for an OAuth access token
 */
export function getHttpSession(accessToken: string): string | null {
  const session = httpSessions.get(accessToken);
  if (session && session.expiresAt > Date.now()) {
    return session.metabaseToken;
  }
  if (session) {
    httpSessions.delete(accessToken);
  }
  return null;
}

/**
 * Get the most recent active session (for single-user scenarios)
 */
export function getActiveHttpSession(): string | null {
  if (lastActiveSession && lastActiveSession.expiresAt > Date.now()) {
    return lastActiveSession.metabaseToken;
  }
  lastActiveSession = null;
  return null;
}

/**
 * Clear all HTTP sessions
 */
export function clearHttpSessions(): void {
  httpSessions.clear();
  lastActiveSession = null;
}

/**
 * Check if we're running in HTTP transport mode
 */
export function isHttpMode(): boolean {
  return process.env.MCP_TRANSPORT === 'http';
}
