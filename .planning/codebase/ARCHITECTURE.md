<!-- refreshed: 2026-06-09 -->
# Architecture

**Analysis Date:** 2026-06-09

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                          Host Application                                │
│  (Next.js app — separate compilation units: settings page, MCP route,  │
│   widget chat route, connectors page)                                   │
└──────────┬───────────────────┬────────────────────────┬────────────────┘
           │ registerDrupalConnector(deps)               │
           ▼                   │                         │
┌──────────────────────┐       │                         │
│  deps.ts (DI seam)   │◄──────┘                         │
│  globalThis Symbol   │   boot-time registration        │
│  `src/deps.ts`       │                                 │
└──────────┬───────────┘                                 │
           │ getDrupalDeps()                             │
           ▼                                             ▼
┌─────────────────────────────┐       ┌──────────────────────────────────┐
│      MCP Layer              │       │       UI Layer                   │
│  `src/mcp/module.ts`        │       │  `src/settings-page.tsx`         │
│  `src/mcp/registry.ts`      │       │  `src/setup-page.tsx`            │
│  `src/mcp/handlers.ts`      │       │  `src/components/ui/`            │
└──────────┬──────────────────┘       └──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────┐
│   HTTP Client Layer         │
│  `src/lib/drupal-mcp-client.ts`                                         │
│  StreamableHTTPClientTransport → Drupal /_mcp_tools endpoint            │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐    ┌─────────────────────────────────────┐
│  Drupal CMS (external)      │    │  wayflow-drupal-content-editor       │
│  drupal/mcp_tools module    │    │  A2A agent (docker, port 3020)       │
│  /_mcp_tools HTTP endpoint  │    │  dispatched via deps.dispatchContentEditor│
└─────────────────────────────┘    └─────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| DI seam (deps) | Anchors host-provided runtime surfaces on `globalThis` via a namespaced Symbol so separately-compiled Next.js bundles share the same slot | `src/deps.ts` |
| MCP module | Thin facade — wraps `registerDrupalPrimitives` as a `registerCapabilities` method for the Cinatra SDK connector protocol | `src/mcp/module.ts` |
| MCP registry | Defines all tool metadata (names, descriptions, Zod input schemas) and registers each tool with the `ExtensionMcpToolServer` | `src/mcp/registry.ts` |
| MCP handlers | Factory that returns all tool handler functions; imports the DI seam and the Drupal HTTP client; owns business logic | `src/mcp/handlers.ts` |
| Drupal MCP client | Connects to a Drupal site's `/_mcp_tools` HTTP endpoint via `@modelcontextprotocol/sdk`; unwraps the `{ success, message, data }` envelope | `src/lib/drupal-mcp-client.ts` |
| Widget chat tool | Builds an LLM function-tool for the CMS widget chat route; forcibly overrides identity fields from server-trusted context (prompt-injection hardening) | `src/widget-chat-tool.ts` |
| Settings page | Next.js Server Component for managing Drupal instances (CRUD + Nango credential linking) | `src/settings-page.tsx` |
| Setup page | Next.js Server Component for initial connector setup flow | `src/setup-page.tsx` |
| UI components | Radix-UI + Tailwind primitive components (button, input, badge, alert, etc.) | `src/components/ui/` |

## Pattern Overview

**Overall:** Cinatra Connector Plugin with Dependency Injection seam

**Key Characteristics:**
- The connector carries zero non-SDK `@cinatra-ai/*` code imports. All host-shared runtime surfaces (pagination, A2A dispatch, Nango bearer header) are injected via `registerDrupalConnector(deps)` at boot.
- The DI slot is anchored on `globalThis` via `Symbol.for(...)` so separately-compiled Next.js bundles (settings page, MCP dispatch route, widget chat route) all resolve the same registered instance without importing the registrar.
- Tool registration follows a two-file split: `registry.ts` owns schema and metadata; `handlers.ts` owns business logic. `module.ts` is a thin bridge to the SDK connector protocol.
- The Drupal HTTP transport is MCP-over-HTTP (`StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk`), not a REST client.

## Layers

**DI / Bootstrap Layer:**
- Purpose: Decouple the connector from host-side runtime dependencies
- Location: `src/deps.ts`
- Contains: `DrupalConnectorDeps` interface, `registerDrupalConnector`, `getDrupalDeps`, `_resetDrupalDepsForTests`
- Depends on: Nothing (pure TypeScript types + `globalThis`)
- Used by: `src/lib/drupal-mcp-client.ts`, `src/mcp/handlers.ts`

**MCP Layer:**
- Purpose: Expose Drupal content operations as MCP tools to the Cinatra platform
- Location: `src/mcp/`
- Contains: tool schemas, descriptions, handler factory, module facade
- Depends on: DI layer, HTTP client layer, `@cinatra-ai/sdk-extensions`
- Used by: Host MCP dispatch route

**HTTP Client Layer:**
- Purpose: Speak MCP-over-HTTP to a Drupal site's `/_mcp_tools` endpoint; unwrap the response envelope
- Location: `src/lib/drupal-mcp-client.ts`
- Contains: `callDrupalMcp` function
- Depends on: DI layer (for `buildNangoBearerHeader`), `@modelcontextprotocol/sdk`
- Used by: MCP handlers layer

**Widget Chat Tool Layer:**
- Purpose: Provide a single LLM function-tool for in-context CMS editing with prompt-injection hardening
- Location: `src/widget-chat-tool.ts`
- Contains: `createDrupalWidgetChatTool`, exported types `DrupalWidgetContext`, `DrupalFunctionTool`, `DrupalToolParameterSchema`
- Depends on: MCP handlers layer
- Used by: Host widget chat route

**UI Layer:**
- Purpose: Settings and setup pages for connector administration
- Location: `src/settings-page.tsx`, `src/setup-page.tsx`, `src/components/ui/`
- Contains: Next.js Server Components, Radix-UI primitives
- Depends on: `@cinatra-ai/sdk-ui`, `@cinatra-ai/sdk-extensions`, host-side `@/lib/drupal-api`, `@/lib/drupal-mcp-connection`
- Used by: Host Next.js routing

## Data Flow

### MCP Tool Call (e.g., drupal_node_update)

1. Host MCP dispatch route receives tool call → `registerDrupalPrimitives` handler fires (`src/mcp/registry.ts:80`)
2. Registry invokes `createDrupalPrimitiveHandlers()[toolName]` (`src/mcp/handlers.ts:92`)
3. Handler parses input with Zod schema (`src/mcp/handlers.ts:140–143`)
4. Handler calls `resolveInstance(instanceId)` → `listDrupalInstances()` (host `@/lib/drupal-api`)
5. Handler calls `callDrupalMcp(instance, TOOL.UPDATE, args)` (`src/lib/drupal-mcp-client.ts:20`)
6. `callDrupalMcp` resolves Nango bearer via `getDrupalDeps().buildNangoBearerHeader(...)` (`src/lib/drupal-mcp-client.ts:26`)
7. MCP `StreamableHTTPClientTransport` connects to `{siteUrl}/_mcp_tools` and calls the Drupal tool
8. Response envelope `{ success, message, data }` is unwrapped; `data` is returned
9. Registry wraps result in `ExtensionMcpToolResult` with `content` + `structuredContent`

### A2A Content Editor Flow (drupal_content_editor_run)

1. Handler parses input (`src/mcp/handlers.ts:247`)
2. Reads `DRUPAL_CONTENT_EDITOR_A2A_URL` env var (default `http://localhost:3020`)
3. Calls `getDrupalDeps().dispatchContentEditor({ agentUrl, payload, timeoutMs: 300_000 })`
4. Host-side: mints A2A bearer, opens external A2A client, sends task, walks `task.history`, resolves with agent reply text
5. Handler strips Markdown code fences from reply text and `JSON.parse`s; falls back to `{ result: text }` on parse failure

### Widget Chat Flow

1. Host widget chat route calls `createDrupalWidgetChatTool({ context })` (`src/widget-chat-tool.ts:38`)
2. LLM calls the tool with only `instructions`; `instanceId`/`nodeId` are forcibly overridden from `context`
3. Tool's `execute()` calls `handlers.drupal_content_editor_run(...)` directly (bypassing MCP registration)

**State Management:**
- No in-process state. All state lives in the host database (Drupal instances) or external services (Nango vault, Drupal CMS).
- DI deps slot on `globalThis` is the only process-scoped mutable reference.

## Key Abstractions

**DrupalConnectorDeps:**
- Purpose: Interface describing all host-provided runtime surfaces this connector needs
- Examples: `src/deps.ts:60`
- Pattern: Constructor injection via `registerDrupalConnector(deps)` at boot; runtime access via `getDrupalDeps()`

**createDrupalPrimitiveHandlers:**
- Purpose: Factory returning a record of typed handler functions, one per MCP tool
- Examples: `src/mcp/handlers.ts:92`
- Pattern: Factory function returning `as const` record; no class, no state

**callDrupalMcp:**
- Purpose: Reusable function to call any Drupal `mcp_tools` tool by name and unwrap the response
- Examples: `src/lib/drupal-mcp-client.ts:20`
- Pattern: Per-call `Client` instantiation and `close()` in `finally`; not a persistent connection

## Entry Points

**Package Public API:**
- Location: `src/index.ts`
- Triggers: Imported by host application
- Responsibilities: Re-exports `createDrupalModule`, `registerDrupalPrimitives`, `createDrupalPrimitiveHandlers`, `createDrupalWidgetChatTool`, `registerDrupalConnector`, and related types

**Settings Page:**
- Location: `src/settings-page.tsx`
- Triggers: Imported directly as `@cinatra-ai/drupal-mcp-connector/settings-page` by host routing
- Responsibilities: Drupal instance CRUD UI (Server Component)

## Architectural Constraints

- **Threading:** Node.js single-threaded event loop. Each MCP tool call opens and closes its own `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport` — no connection pooling.
- **Global state:** `globalThis[Symbol.for("@cinatra-ai/drupal-mcp-connector:host-deps/v1")]` — single mutable slot, set once at boot by the host. See `src/deps.ts:71`.
- **Circular imports:** None detected.
- **No non-SDK @cinatra-ai imports:** The package intentionally carries zero `@cinatra-ai/*` code dependencies other than the optional peer deps `@cinatra-ai/sdk-extensions` and `@cinatra-ai/sdk-ui`. All other host surfaces come via the DI seam.
- **server-only:** `src/lib/drupal-mcp-client.ts` and `src/settings-page.tsx` include `import "server-only"` — they must not be bundled into client-side code.

## Anti-Patterns

### Direct host import

**What happens:** Importing `@cinatra-ai/nango-connector`, `@cinatra-ai/a2a`, or `@cinatra-ai/llm` directly inside this package.
**Why it's wrong:** Creates hard runtime coupling that breaks separately-compiled Next.js bundles and violates the connector isolation contract.
**Do this instead:** Add the needed surface to `DrupalConnectorDeps` in `src/deps.ts` and inject from the host.

### Persistent MCP Client

**What happens:** Holding a `Client` instance across calls instead of creating one per invocation.
**Why it's wrong:** `StreamableHTTPClientTransport` is stateful per-session; reuse causes stale-connection errors.
**Do this instead:** Follow the pattern in `src/lib/drupal-mcp-client.ts` — `new Client(...)`, `connect`, `callTool`, `close()` in `finally`.

### Including token in error messages

**What happens:** Logging or throwing errors that interpolate `authHeader.Authorization` or bearer token values.
**Why it's wrong:** Leaks credentials into logs and error reporting.
**Do this instead:** Use label-only error messages as in `src/lib/drupal-mcp-client.ts:29` — `label: \`drupal-${instance.id}\`` with no secret material.

## Error Handling

**Strategy:** Throw `Error` with descriptive messages. No custom error classes. Zod `.parse()` throws `ZodError` on invalid input. `callDrupalMcp` surfaces Drupal's `{ success: false, message }` envelope as a thrown `Error`.

**Patterns:**
- Zod schema `.parse(request.input)` at the top of each handler — throws before any I/O on bad input
- Explicit `Number.isFinite(nid) && nid > 0` guard before Drupal calls on node IDs
- `try/catch` around `JSON.parse` in `drupal_content_editor_run` — falls back to `{ result: text }`
- `client.close().catch(() => {})` in `finally` to suppress close errors

## Cross-Cutting Concerns

**Logging:** Not detected — no logger import. Errors are thrown; the host/SDK handles logging.
**Validation:** Zod schemas defined in `src/mcp/handlers.ts` and applied at handler entry. Schemas are also exported for use in `src/mcp/registry.ts`.
**Authentication:** Two distinct surfaces — (1) Nango vault bearer for Drupal MCP HTTP calls (`buildNangoBearerHeader` in DI deps), (2) A2A bearer minted host-side for content-editor agent dispatch. Neither secret touches this package's code.

---

*Architecture analysis: 2026-06-09*
