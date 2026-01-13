/**
 * HTTP Server Transport for MCP with full OAuth Authorization Server
 *
 * Implements the MCP Streamable HTTP transport with:
 * - Full OAuth 2.1 Authorization Server
 * - Dynamic Client Registration (RFC 7591)
 * - Google OAuth proxy for authentication
 * - Metabase session management
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import config from '../config.js';
import {
  oauthServerProvider,
  handleGoogleCallback,
  getMetabaseSession,
} from '../auth/oauthServer.js';

/**
 * Create and configure the Express app with MCP endpoints
 */
export function createHttpApp(mcpServer: Server): Express {
  const app = express();

  // Parse JSON and URL-encoded bodies
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Build server URLs
  const baseUrl = new URL(`http://${config.MCP_HTTP_HOST}:${config.MCP_HTTP_PORT}`);

  // Setup full OAuth Authorization Server router
  // This exposes:
  // - /.well-known/oauth-authorization-server (AS metadata)
  // - /.well-known/oauth-protected-resource (RS metadata)
  // - /authorize (authorization endpoint)
  // - /token (token endpoint)
  // - /register (dynamic client registration)
  // - /revoke (token revocation)
  app.use(
    mcpAuthRouter({
      provider: oauthServerProvider,
      issuerUrl: baseUrl,
      baseUrl: baseUrl,
      serviceDocumentationUrl: new URL('https://github.com/jerichosequitin/metabase-mcp'),
      scopesSupported: ['openid', 'email', 'profile', 'metabase'],
      resourceName: 'Metabase MCP Server',
    })
  );

  // Google OAuth callback endpoint (implicit flow)
  // With implicit flow, the id_token comes in the URL fragment (#)
  // We serve an HTML page that extracts it and sends to our token endpoint
  app.get('/oauth/callback', async (req: Request, res: Response) => {
    // Check for errors in query string (Google puts errors there, not fragment)
    const error = req.query.error as string;
    if (error) {
      res.status(400).send(`
        <html>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1>Authentication Failed</h1>
            <p>Error: ${error}</p>
            <p>You can close this window.</p>
          </body>
        </html>
      `);
      return;
    }

    // Serve HTML that extracts id_token from fragment and POSTs to our server
    res.send(`
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
          <p id="status">Processing Google sign-in...</p>
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

              // POST the id_token to our server
              fetch('/oauth/token-callback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_token: idToken, state: state })
              })
              .then(res => res.json())
              .then(data => {
                if (data.redirect_url) {
                  window.location.href = data.redirect_url;
                } else if (data.error) {
                  document.getElementById('status').textContent = 'Error: ' + data.error;
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
  });

  // Token callback - receives id_token from the browser
  app.post('/oauth/token-callback', async (req: Request, res: Response) => {
    try {
      const { id_token, state } = req.body;

      if (!id_token || !state) {
        res.status(400).json({ error: 'Missing id_token or state' });
        return;
      }

      const { redirectUrl } = await handleGoogleCallback(id_token, state);
      res.json({ redirect_url: redirectUrl });
    } catch (err) {
      console.error('[OAuth] Token callback error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // Create the StreamableHTTPServerTransport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // Connect MCP server to transport
  mcpServer.connect(transport).catch(err => {
    console.error('Failed to connect MCP server to HTTP transport:', err);
  });

  // Health check endpoint (no auth required)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', oauth: 'enabled' });
  });

  // MCP endpoint with bearer auth
  const mcpPath = '/mcp';

  // Bearer auth middleware
  const authMiddleware = requireBearerAuth({
    verifier: oauthServerProvider,
    requiredScopes: [],
    resourceMetadataUrl: `${baseUrl.origin}/.well-known/oauth-protected-resource`,
  });

  // Custom middleware to inject Metabase session into request
  const injectMetabaseSession = (req: Request, _res: Response, next: NextFunction) => {
    if (req.auth?.token) {
      const metabaseSession = getMetabaseSession(req.auth.token);
      if (metabaseSession) {
        // Store in auth.extra for handlers to use
        req.auth.extra = {
          ...req.auth.extra,
          metabaseSessionToken: metabaseSession,
        };
      }
    }
    next();
  };

  // MCP endpoint - handles both POST (requests) and GET (SSE streaming)
  app.all(
    mcpPath,
    authMiddleware,
    injectMetabaseSession,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        next(error);
      }
    }
  );

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('HTTP server error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: err.message,
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startHttpServer(mcpServer: Server): Promise<void> {
  const app = createHttpApp(mcpServer);

  const host = config.MCP_HTTP_HOST;
  const port = config.MCP_HTTP_PORT;

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.error(`Metabase MCP HTTP server listening on http://${host}:${port}`);
      console.error(`MCP endpoint: http://${host}:${port}/mcp`);
      console.error(`OAuth authorize: http://${host}:${port}/authorize`);
      console.error(
        `OAuth metadata: http://${host}:${port}/.well-known/oauth-authorization-server`
      );
      console.error(`\nTo use with Claude Code:`);
      console.error(`  claude mcp add --transport http metabase http://${host}:${port}/mcp`);
      resolve();
    });

    server.on('error', (err: Error) => {
      console.error('Failed to start HTTP server:', err);
      reject(err);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.error('Shutting down HTTP server...');
      server.close(() => {
        console.error('HTTP server closed');
        process.exit(0);
      });
    });

    process.on('SIGTERM', () => {
      console.error('Shutting down HTTP server...');
      server.close(() => {
        console.error('HTTP server closed');
        process.exit(0);
      });
    });
  });
}
