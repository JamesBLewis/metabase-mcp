/**
 * OAuth Authorization Server implementation for MCP
 *
 * Acts as an OAuth AS that:
 * 1. Supports Dynamic Client Registration (RFC 7591)
 * 2. Proxies authentication to Google OAuth
 * 3. Exchanges Google tokens for Metabase sessions
 * 4. Issues access tokens mapped to Metabase sessions
 */

import { Response } from 'express';
import { randomBytes } from 'crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import config from '../config.js';
import { setHttpSession } from './httpSessionStore.js';

// Google OAuth endpoint
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// Storage for registered clients (in-memory for now)
const registeredClients = new Map<string, OAuthClientInformationFull>();

// Storage for pending authorizations (code -> session data)
interface PendingAuth {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  googleState: string;
  nonce: string;
  clientState?: string; // Original state from Claude Code
  createdAt: number;
}
const pendingAuthorizations = new Map<string, PendingAuth>();

// Storage for issued tokens -> Metabase sessions
interface TokenSession {
  metabaseSessionToken: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  email?: string;
}
const tokenSessions = new Map<string, TokenSession>();

// Cleanup expired entries periodically
setInterval(
  () => {
    const now = Date.now();
    for (const [code, auth] of pendingAuthorizations.entries()) {
      if (now - auth.createdAt > 10 * 60 * 1000) {
        // 10 min expiry
        pendingAuthorizations.delete(code);
      }
    }
    for (const [token, session] of tokenSessions.entries()) {
      if (session.expiresAt < now) {
        tokenSessions.delete(token);
      }
    }
  },
  5 * 60 * 1000
);

/**
 * Generate a cryptographically secure random string
 */
function generateSecureToken(bytes: number = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Generate PKCE code verifier
 */
function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Exchange Google ID token for Metabase session
 */
async function exchangeForMetabaseSession(
  idToken: string
): Promise<{ sessionToken: string; expiresAt: number }> {
  const metabaseUrl = config.METABASE_URL.replace(/\/+$/, '');

  const response = await fetch(`${metabaseUrl}/api/session/google_auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: idToken }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Metabase authentication failed: ${error}`);
  }

  const data = (await response.json()) as { id: string };

  return {
    sessionToken: data.id,
    expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000, // 14 days
  };
}

/**
 * Decode JWT payload without verification (for extracting email)
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * OAuth Registered Clients Store implementation
 */
export const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return registeredClients.get(clientId);
  },

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
  ): OAuthClientInformationFull {
    const clientId = generateSecureToken(16);
    const clientSecret = generateSecureToken(32);

    const fullClient: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
    };

    registeredClients.set(clientId, fullClient);
    console.error(`[OAuth] Registered new client: ${clientId}`);

    return fullClient;
  },
};

/**
 * OAuth Server Provider implementation
 */
export const oauthServerProvider: OAuthServerProvider = {
  get clientsStore(): OAuthRegisteredClientsStore {
    return clientsStore;
  },

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Generate our own auth code
    const authCode = generateSecureToken(32);

    // Generate nonce for implicit flow
    const nonce = generateCodeVerifier();
    const googleState = generateSecureToken(16);

    // Store pending authorization (including client's original state)
    pendingAuthorizations.set(authCode, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes || [],
      googleState,
      nonce,
      clientState: params.state, // Preserve Claude Code's state
      createdAt: Date.now(),
    });

    // Build Google OAuth URL
    // Note: We use our own callback URL, then redirect back to the client
    // Use localhost for Google OAuth as it's more commonly configured in Cloud Console
    const oauthHost = config.MCP_HTTP_HOST === '127.0.0.1' ? 'localhost' : config.MCP_HTTP_HOST;
    const callbackUrl = `http://${oauthHost}:${config.MCP_HTTP_PORT}/oauth/callback`;

    // Use implicit flow to get ID token directly (no client secret needed)
    // This mimics how Metabase's browser-based Google SSO works
    const googleParams = new URLSearchParams({
      client_id: config.METABASE_GOOGLE_CLIENT_ID!,
      redirect_uri: callbackUrl,
      response_type: 'id_token',
      scope: 'openid email profile',
      state: `${authCode}:${googleState}`,
      nonce,
    });

    const googleAuthUrl = `${GOOGLE_AUTH_URL}?${googleParams.toString()}`;

    console.error(`[OAuth] Redirecting to Google for client ${client.client_id}`);
    res.redirect(googleAuthUrl);
  },

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const pending = pendingAuthorizations.get(authorizationCode);
    if (!pending) {
      throw new Error('Invalid authorization code');
    }
    return pending.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string
  ): Promise<OAuthTokens> {
    const pending = pendingAuthorizations.get(authorizationCode);
    if (!pending) {
      throw new Error('Invalid or expired authorization code');
    }

    if (pending.clientId !== client.client_id) {
      throw new Error('Client ID mismatch');
    }

    // The Google exchange should have already happened in the callback
    // The auth code now maps to a Metabase session
    const session = tokenSessions.get(authorizationCode);
    if (!session) {
      throw new Error('Session not found - authorization may have failed');
    }

    // Generate access token for the client
    const accessToken = generateSecureToken(32);

    // Move session from auth code to access token
    tokenSessions.set(accessToken, session);
    tokenSessions.delete(authorizationCode);
    pendingAuthorizations.delete(authorizationCode);

    // Store in shared HTTP session store for API client access
    setHttpSession(accessToken, session.metabaseSessionToken, session.expiresAt);

    console.error(`[OAuth] Issued access token for client ${client.client_id}`);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor((session.expiresAt - Date.now()) / 1000),
      scope: session.scopes.join(' '),
    };
  },

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    _refreshToken: string,
    _scopes?: string[]
  ): Promise<OAuthTokens> {
    // We don't support refresh tokens (same as Google PKCE)
    throw new Error('Refresh tokens not supported');
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const session = tokenSessions.get(token);
    if (!session) {
      throw new Error('Invalid access token');
    }

    if (session.expiresAt < Date.now()) {
      tokenSessions.delete(token);
      throw new Error('Access token expired');
    }

    return {
      token,
      clientId: session.clientId,
      scopes: session.scopes,
      expiresAt: Math.floor(session.expiresAt / 1000),
      extra: {
        email: session.email,
        metabaseSessionToken: session.metabaseSessionToken,
      },
    };
  },

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    tokenSessions.delete(request.token);
    console.error(`[OAuth] Revoked token`);
  },
};

/**
 * Handle Google OAuth callback (implicit flow)
 * Receives the ID token directly from Google
 */
export async function handleGoogleCallback(
  idToken: string,
  state: string
): Promise<{ redirectUrl: string }> {
  // Parse state to get our auth code
  const [authCode, googleState] = state.split(':');

  const pending = pendingAuthorizations.get(authCode);
  if (!pending) {
    throw new Error('Invalid state - authorization not found');
  }

  if (pending.googleState !== googleState) {
    throw new Error('State mismatch - possible CSRF attack');
  }

  // Extract email from ID token
  const tokenPayload = decodeJwtPayload(idToken);
  const email = tokenPayload?.email as string | undefined;

  console.error(`[OAuth] Google auth successful for ${email}`);

  // Exchange Google ID token for Metabase session
  const metabaseSession = await exchangeForMetabaseSession(idToken);

  console.error(`[OAuth] Metabase session obtained`);

  // Store session mapped to auth code (will be moved to access token later)
  tokenSessions.set(authCode, {
    metabaseSessionToken: metabaseSession.sessionToken,
    clientId: pending.clientId,
    scopes: pending.scopes,
    expiresAt: metabaseSession.expiresAt,
    email,
  });

  // Redirect back to client with our auth code and their original state
  const redirectUrl = new URL(pending.redirectUri);
  redirectUrl.searchParams.set('code', authCode);
  if (pending.clientState) {
    redirectUrl.searchParams.set('state', pending.clientState);
  }

  return { redirectUrl: redirectUrl.toString() };
}

/**
 * Get Metabase session token from an access token
 */
export function getMetabaseSession(accessToken: string): string | null {
  const session = tokenSessions.get(accessToken);
  return session?.metabaseSessionToken || null;
}
