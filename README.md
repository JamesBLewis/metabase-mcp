# Metabase MCP

A high-performance Model Context Protocol server for AI integration with Metabase analytics platforms. Features response optimization, robust error handling, and comprehensive data access tools.

**Note:** This is Nelo's private fork with built-in defaults for Nelo's Metabase instance. For the public version, see [jerichosequitin/metabase-mcp](https://github.com/jerichosequitin/metabase-mcp).

## Key Features

- **Response Optimization**: Up to 90% token reduction for efficient AI context usage
- **Robust Error Handling**: Comprehensive error handling with structured, actionable responses
- **Smart Caching**: Multi-layer caching with configurable TTL for improved performance
- **Unified Commands**: `list`, `retrieve`, `search`, `execute`, and `export` tools
- **Flexible Authentication**: API key, email/password, or Google SSO
- **Large Data Export**: Export up to 1M rows in CSV, JSON, and XLSX formats
- **Read-Only Mode**: Enabled by default to restrict execute to SELECT queries only

## Installation for Nelo Users

### Quick Start (Zero Configuration)

1. **First-time setup**: Authenticate with Google SSO
   ```bash
   npx @nelo/metabase-mcp auth login
   ```
   This opens your browser to sign in with your Nelo Google account.

2. **Add to Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
   ```jsonc
   {
     "mcpServers": {
       "metabase-mcp": {
         "command": "npx",
         "args": ["-y", "@nelo/metabase-mcp"]
       }
     }
   }
   ```

That's it - no environment variables needed. The package has built-in defaults for Nelo's Metabase instance.

### Optional Configuration

Override defaults if needed:

```jsonc
{
  "mcpServers": {
    "metabase-mcp": {
      "command": "npx",
      "args": ["-y", "@nelo/metabase-mcp"],
      "env": {
        // Override Nelo defaults
        "METABASE_URL": "https://different-instance.com",
        "METABASE_GOOGLE_CLIENT_ID": "different-client-id",

        // Other options (defaults shown)
        "EXPORT_DIRECTORY": "~/Downloads/Metabase",
        "METABASE_READ_ONLY_MODE": "true",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

## Available Tools

### `list`
Fetch all records for a resource type with optimized responses returning only essential fields.
- **Models**: `cards`, `dashboards`, `tables`, `databases`, `collections`
- **Pagination**: `offset`/`limit` parameters for large datasets

### `retrieve`
Get detailed information for specific items by ID with concurrent processing.
- **Models**: `card`, `dashboard`, `table`, `database`, `collection`, `field`
- **Batch Support**: Up to 50 IDs per request
- **Pagination**: `table_offset`/`table_limit` for databases with many tables

### `search`
Search across all Metabase items using the native search API.
- **Filtering**: By model type, database ID, or content
- **Options**: Search native SQL queries, include dashboard questions

### `execute`
Execute SQL queries or run saved cards with configurable row limits (default: 100, max: 500).
- **SQL Mode**: Custom queries with `database_id` and `query`
- **Card Mode**: Saved cards with `card_id` and optional `card_parameters` for filtering
- **Security**: Respects Read-Only Mode (blocks INSERT, UPDATE, DELETE, DROP, etc.)

### `export`
Export large datasets up to 1M rows to the configured export directory.
- **Formats**: CSV, JSON, XLSX
- **SQL Mode**: Export custom query results
- **Card Mode**: Export saved card results with optional filtering
- **Note**: When using hosted remote deployments (e.g., Glama), exported files are saved inside the container and are inaccessible. Use `execute` for query results directly, or run locally via npx/Docker for full export functionality.

### `clear_cache`
Clear internal cache with granular control.
- **Targets**: Individual model caches, list caches, or bulk operations (`all`, `all-lists`, `all-individual`)

## Authentication

For Nelo users, just run:
```bash
npx @nelo/metabase-mcp auth login
```

This opens your browser to sign in with Google SSO. Your session is stored locally at `~/.metabase-mcp/auth.json`.

See [docs/auth.md](docs/auth.md) for detailed authentication options including API key and email/password methods.

## HTTP Transport Mode (Advanced)

For MCP clients supporting native OAuth, the server can run in HTTP mode:

```bash
MCP_TRANSPORT=http
MCP_HTTP_PORT=3100
MCP_HTTP_HOST=127.0.0.1
```

This exposes an HTTP server with:
- MCP endpoint at `/mcp` (POST/GET)
- OAuth Protected Resource Metadata at `/.well-known/oauth-protected-resource`

See [docs/auth.md](docs/auth.md#http-transport-mode-with-native-mcp-oauth) for details.

## For Developers

### Prerequisites
- Node.js 18.0.0 or higher
- Active Metabase instance

### Setup

```bash
git clone https://github.com/nelo/metabase-mcp.git
cd metabase-mcp
npm install
npm run build
```

Then configure your MCP client to use the local build:

```jsonc
{
  "mcpServers": {
    "metabase-mcp": {
      "command": "node",
      "args": ["/path/to/metabase-mcp/build/src/index.js"],
      "env": { /* see Manual Configuration for options */ }
    }
  }
}
```

### Debugging

Use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) for development:

```bash
npm run inspector
```

### Testing

```bash
npm test                 # Run tests
npm run test:coverage    # Coverage report
```

### Building MCPB Package

```bash
npm run mcpb:build
```

Creates `metabase-mcp-{version}.mcpb` ready for GitHub Releases.

## Security

**Read-Only Mode** is enabled by default (`METABASE_READ_ONLY_MODE=true`), restricting the `execute` tool to SELECT queries only. Write operations (INSERT, UPDATE, DELETE, DROP, etc.) are blocked. Set to `false` to allow write operations.

- **API Key Authentication**: Recommended for production environments
- **Credential Security**: Environment variable-based configuration
- **Google SSO Tokens**: Encrypted at rest in `~/.metabase-mcp/auth.json`

For detailed security best practices, see [docs/auth.md](docs/auth.md#security-best-practices).

## License

This project is licensed under the MIT License.
