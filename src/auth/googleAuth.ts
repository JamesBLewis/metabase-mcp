/**
 * Google OAuth authentication handler for Metabase SSO
 *
 * Handles the OAuth flow:
 * 1. Generate authorization URL
 * 2. Start local callback server
 * 3. Exchange authorization code for tokens
 * 4. Exchange Google ID token for Metabase session
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL, URLSearchParams } from 'url';
import { randomBytes } from 'crypto';
import config, { getGoogleOAuthConfig } from '../config.js';
import { tokenStore } from './tokenStore.js';
import type { GoogleTokens, StoredAuth, MetabaseSessionResult } from '../types/auth.js';

// Google OAuth endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Metabase session duration (14 days default)
const METABASE_SESSION_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Generate a random state parameter for CSRF protection
 */
function generateState(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generate a PKCE code verifier (43-128 character random string)
 * Uses base64url encoding as per RFC 7636
 */
function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Generate the Google OAuth authorization URL with implicit flow
 * Returns the URL, state (for CSRF protection), and nonce
 * Uses implicit flow (response_type=id_token) to avoid needing a client secret
 */
export function getAuthorizationUrl(): { url: string; state: string; nonce: string } {
  const oauthConfig = getGoogleOAuthConfig();

  if (!oauthConfig) {
    throw new Error('Google SSO not configured. Set METABASE_GOOGLE_CLIENT_ID.');
  }

  const state = generateState();
  const nonce = generateCodeVerifier(); // Reuse for nonce generation

  const params = new URLSearchParams({
    client_id: oauthConfig.clientId,
    redirect_uri: oauthConfig.redirectUri,
    response_type: 'id_token',
    scope: oauthConfig.scopes.join(' '),
    state,
    nonce,
  });

  return {
    url: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    state,
    nonce,
  };
}

/**
 * Start a local HTTP server to capture the OAuth callback (implicit flow)
 * With implicit flow, the id_token comes in the URL fragment (#)
 * We serve an HTML page that extracts it and POSTs it back
 */
export function startCallbackServer(
  expectedState: string,
  timeoutMs: number = 120000
): Promise<{ idToken: string; state: string }> {
  const oauthConfig = getGoogleOAuthConfig();

  if (!oauthConfig) {
    throw new Error('Google SSO not configured');
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const reqUrl = new URL(req.url || '/', `http://localhost:${oauthConfig.callbackPort}`);

      // Handle the initial callback - serve HTML to extract token from fragment
      if (reqUrl.pathname === '/callback' && req.method === 'GET') {
        const error = reqUrl.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>Authentication Failed</h1>
                <p>Error: ${error}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        // Serve HTML that extracts token from fragment and POSTs it
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Completing authentication...</title>
              <style>
                body { font-family: system-ui; padding: 40px; text-align: center; }
                .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
              </style>
            </head>
            <body>
              <h2>Completing authentication...</h2>
              <div class="spinner"></div>
              <p id="status">Processing...</p>
              <script>
                (function() {
                  const hash = window.location.hash.substring(1);
                  const params = new URLSearchParams(hash);
                  const idToken = params.get('id_token');
                  const state = params.get('state');
                  const error = params.get('error');

                  if (error) {
                    document.getElementById('status').textContent = 'Error: ' + error;
                    return;
                  }

                  if (!idToken || !state) {
                    document.getElementById('status').textContent = 'Missing token or state';
                    return;
                  }

                  // POST the token to our server
                  fetch('/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id_token: idToken, state: state })
                  })
                  .then(res => res.json())
                  .then(data => {
                    if (data.success) {
                      document.getElementById('status').innerHTML = '<h1>Authentication Successful!</h1><p>You can close this window.</p>';
                      document.querySelector('.spinner').style.display = 'none';
                      document.querySelector('h2').style.display = 'none';
                      setTimeout(() => window.close(), 2000);
                    } else {
                      document.getElementById('status').textContent = 'Error: ' + (data.error || 'Unknown error');
                    }
                  })
                  .catch(err => {
                    document.getElementById('status').textContent = 'Error: ' + err.message;
                  });
                })();
              </script>
            </body>
          </html>
        `);
        return;
      }

      // Handle the token POST from the HTML page
      if (reqUrl.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const { id_token: idToken, state } = data;

            if (!idToken || !state) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Missing token or state' }));
              return;
            }

            if (state !== expectedState) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'State mismatch' }));
              server.close();
              reject(new Error('State mismatch - possible CSRF attack'));
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            server.close();
            resolve({ idToken, state });
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    // Set timeout
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error(`OAuth callback timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    server.on('close', () => {
      clearTimeout(timeout);
    });

    server.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });

    server.listen(oauthConfig.callbackPort, () => {
      console.error(`OAuth callback server listening on port ${oauthConfig.callbackPort}`);
    });
  });
}

/**
 * Exchange authorization code for Google tokens using PKCE
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string
): Promise<GoogleTokens> {
  const oauthConfig = getGoogleOAuthConfig();

  if (!oauthConfig) {
    throw new Error('Google SSO not configured');
  }

  const params = new URLSearchParams({
    code,
    client_id: oauthConfig.clientId,
    redirect_uri: oauthConfig.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      `Failed to exchange code for tokens: ${response.status} ${JSON.stringify(errorData)}`
    );
  }

  const data = (await response.json()) as {
    id_token: string;
    access_token: string;
    expires_in: number;
  };

  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/**
 * Decode JWT payload (without verification) for debugging
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Exchange Google ID token for Metabase session
 */
export async function exchangeForMetabaseSession(idToken: string): Promise<MetabaseSessionResult> {
  // Debug: decode and log token claims
  const tokenPayload = decodeJwtPayload(idToken);
  if (tokenPayload) {
    console.error('\nID Token claims:');
    console.error(`  iss (issuer): ${tokenPayload.iss}`);
    console.error(`  aud (audience/client_id): ${tokenPayload.aud}`);
    console.error(`  email: ${tokenPayload.email}`);
    console.error(
      `  exp (expires): ${new Date((tokenPayload.exp as number) * 1000).toISOString()}`
    );
    console.error('');
  }

  const metabaseUrl = config.METABASE_URL.replace(/\/+$/, '');
  const response = await fetch(`${metabaseUrl}/api/session/google_auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token: idToken }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorData: Record<string, unknown> = {};
    try {
      errorData = JSON.parse(errorText);
    } catch {
      errorData = { raw: errorText };
    }

    console.error(`\nMetabase response: ${response.status}`);
    console.error(`Error details: ${JSON.stringify(errorData, null, 2)}`);

    // Handle specific error cases with actual error details
    if (response.status === 401) {
      throw new Error(
        `Google authentication failed (401): ${JSON.stringify(errorData)}. Your Google account may not have access to this Metabase instance.`
      );
    }

    if (response.status === 400) {
      throw new Error(
        `Invalid Google token (400): ${JSON.stringify(errorData)}. Check that the client ID matches Metabase's configuration.`
      );
    }

    throw new Error(
      `Failed to authenticate with Metabase: ${response.status} ${JSON.stringify(errorData)}`
    );
  }

  const data = (await response.json()) as { id: string };

  return {
    sessionToken: data.id,
    // Metabase sessions typically last 14 days
    expiresAt: Date.now() + METABASE_SESSION_DURATION_MS,
  };
}

/**
 * Perform full login flow and store credentials
 * Uses implicit flow to get ID token directly without requiring a client secret
 */
export async function performLogin(): Promise<StoredAuth> {
  // Generate auth URL with implicit flow
  const { url, state } = getAuthorizationUrl();

  console.error('\nOpening browser for Google authentication...');
  console.error(`\nIf browser doesn't open, visit:\n${url}\n`);

  // Dynamically import 'open' to avoid bundling issues
  const open = (await import('open')).default;
  await open(url);

  // Start callback server and wait for ID token (implicit flow returns token directly)
  console.error('Waiting for authentication callback...');
  const { idToken } = await startCallbackServer(state);

  // Exchange Google ID token for Metabase session
  console.error('Authenticating with Metabase...');
  const { sessionToken, expiresAt } = await exchangeForMetabaseSession(idToken);

  // Store authentication (we don't have full Google tokens with implicit flow, just the ID token)
  const googleTokens: GoogleTokens = {
    idToken,
    accessToken: '', // Not provided in implicit flow
    expiresAt: Date.now() + 3600 * 1000, // ID tokens typically expire in 1 hour
  };

  const auth: StoredAuth = {
    method: 'google_sso',
    metabaseUrl: config.METABASE_URL,
    sessionToken,
    sessionExpiresAt: expiresAt || Date.now() + METABASE_SESSION_DURATION_MS,
    googleTokens,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await tokenStore.save(auth);
  console.error(`\nAuthentication successful! Credentials saved to ${tokenStore.getStoragePath()}`);

  return auth;
}

/**
 * Attempt to refresh session using stored tokens
 * Note: With PKCE, we don't get refresh tokens, so if the Google ID token
 * is expired, the user will need to re-authenticate
 */
export async function refreshSession(): Promise<string | null> {
  const googleTokens = await tokenStore.getGoogleTokens();

  if (!googleTokens) {
    return null;
  }

  // If Google tokens are expired, user needs to re-authenticate
  // (PKCE flow doesn't provide refresh tokens)
  if (googleTokens.expiresAt < Date.now()) {
    console.error('Google tokens expired. Please run "auth login" to re-authenticate.');
    return null;
  }

  // If Google tokens are still valid, get a new Metabase session
  try {
    const { sessionToken, expiresAt } = await exchangeForMetabaseSession(googleTokens.idToken);
    await tokenStore.updateSession(sessionToken, expiresAt);
    return sessionToken;
  } catch {
    return null;
  }
}

/**
 * Get valid session token, refreshing if necessary
 */
export async function getValidSession(): Promise<string | null> {
  // First, try to get existing valid session
  const existingToken = await tokenStore.getSessionToken();
  if (existingToken) {
    return existingToken;
  }

  // Try to refresh
  return refreshSession();
}
