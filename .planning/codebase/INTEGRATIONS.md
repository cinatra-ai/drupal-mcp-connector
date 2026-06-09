# External Integrations

**Analysis Date:** 2026-06-09

## APIs & External Services

**Drupal CMS (MCP over HTTP):**
- Drupal 11 sites running the `drupal/mcp_tools ^1.0@beta` module
  - Endpoint: `{siteUrl}/_mcp_tools` (constructed in `src/lib/drupal-mcp-client.ts`)
  - SDK/Client: `@modelcontextprotocol/sdk` — `Client` + `StreamableHTTPClientTransport`
  - Auth: Bearer token sourced from Nango vault (injected via `buildNangoBearerHeader` DI dep)
  - MCP tools called: `mcp_tools_get_recent_content`, `mcp_update_content`, `mcp_create_content`, `mcp_publish_content`

**WayFlow Drupal Content Editor Agent (A2A):**
- An external A2A agent (`wayflow-drupal-content-editor`) that performs natural-language Drupal edits
  - Endpoint: `DRUPAL_CONTENT_EDITOR_A2A_URL` env var (default `http://localhost:3020`)
  - Protocol: A2A blocking dispatch; host-side implementation mints A2A bearer via `buildA2aBearerToken("openai")`
  - Surface in connector: `dispatchContentEditor` DI dep resolved via `getDrupalDeps()` in `src/mcp/handlers.ts`
  - The connector only handles `stripCodeFences` + `JSON.parse` of the agent reply; all transport details are host-side

## Data Storage

**Databases:**
- Not applicable — this connector package contains no direct database access
- Drupal instance configuration (site URLs, connection IDs) is read from the host via `listDrupalInstances()` (imported from `@/lib/drupal-api`, a host-side module)

**File Storage:**
- Not applicable

**Caching:**
- Not applicable

## Authentication & Identity

**Nango (OAuth/credential vault):**
- Connector requests `nango` host port in `package.json` `cinatra.requestedHostPorts`
- Auth flow: `buildNangoBearerHeader({ providerConfigKey, connectionId, label })` is called per MCP request in `src/lib/drupal-mcp-client.ts`
- Implementation: host-bound DI dep (`DrupalNangoBearerHeaderInput` type in `src/deps.ts`); this package carries no `@cinatra-ai/nango-connector` import
- Returns `{ Authorization: string } | null`; null causes a clear thrown error without leaking token values

**A2A Bearer (agent-to-agent):**
- Minted host-side via `buildA2aBearerToken("openai")`; connector never sees the token
- Used only for `drupal_content_editor_run` tool dispatches

## Monitoring & Observability

**Error Tracking:**
- Not detected — no error tracking SDK imported

**Logs:**
- No explicit logging framework; errors are thrown with descriptive messages (e.g., `src/lib/drupal-mcp-client.ts`, `src/mcp/handlers.ts`)

## CI/CD & Deployment

**Hosting:**
- Deployed as a Cinatra connector plugin inside the host Next.js application
- Plugin manifest: `cinatra/plugin.json`
- Connector kind: `connector` (from `package.json` `cinatra.kind`)

**CI Pipeline:**
- `.github/` directory present; specific workflow files not inspected

## Environment Configuration

**Required env vars:**
- `DRUPAL_CONTENT_EDITOR_A2A_URL` — A2A endpoint for wayflow-drupal-content-editor agent (defaults to `http://localhost:3020`)

**Secrets location:**
- No `.env` file in this package
- Drupal MCP Bearer credentials stored in Nango vault; resolved at runtime via host DI

## Webhooks & Callbacks

**Incoming:**
- Not applicable — this package is a connector plugin, not a server

**Outgoing:**
- HTTP calls to `{siteUrl}/_mcp_tools` (Drupal MCP endpoint) via `StreamableHTTPClientTransport` in `src/lib/drupal-mcp-client.ts`
- HTTP calls to the A2A agent endpoint (`DRUPAL_CONTENT_EDITOR_A2A_URL`) dispatched host-side

---

*Integration audit: 2026-06-09*
