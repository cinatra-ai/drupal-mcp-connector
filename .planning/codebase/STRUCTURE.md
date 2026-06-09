# Codebase Structure

**Analysis Date:** 2026-06-09

## Directory Layout

```
drupal-mcp-connector/
├── cinatra/
│   └── plugin.json          # Cinatra connector manifest (id, name, description)
├── src/
│   ├── index.ts             # Package public API — all re-exports
│   ├── deps.ts              # Host DI seam — globalThis-anchored deps slot
│   ├── settings-page.tsx    # Next.js Server Component for instance CRUD UI
│   ├── setup-page.tsx       # Next.js Server Component for initial setup flow
│   ├── widget-chat-tool.ts  # LLM function-tool for CMS widget chat route
│   ├── mcp/
│   │   ├── module.ts        # Thin SDK connector facade (registerCapabilities)
│   │   ├── registry.ts      # Tool metadata + registration with ExtensionMcpToolServer
│   │   └── handlers.ts      # Handler factory + Zod schemas for all MCP tools
│   ├── lib/
│   │   ├── drupal-mcp-client.ts  # MCP-over-HTTP client to Drupal /_mcp_tools
│   │   └── utils.ts              # Shared utilities (cn() className helper)
│   ├── components/
│   │   └── ui/
│   │       ├── alert.tsx
│   │       ├── badge.tsx
│   │       ├── button.tsx
│   │       ├── field.tsx
│   │       ├── input-group.tsx
│   │       ├── input.tsx
│   │       ├── label.tsx
│   │       ├── separator.tsx
│   │       └── textarea.tsx
│   └── __tests__/
│       ├── content-editor-run.test.ts
│       ├── drupal-mcp-client.test.ts
│       ├── handlers.test.ts
│       └── widget-chat-tool.test.ts
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .npmrc
├── AGENTS.md
├── LICENSE
└── README.md
```

## Directory Purposes

**`cinatra/`:**
- Purpose: Cinatra platform manifest for connector discovery
- Contains: `plugin.json` — connector id, display name, description
- Key files: `cinatra/plugin.json`

**`src/mcp/`:**
- Purpose: All MCP tool registration logic
- Contains: module facade, tool registry with descriptions and schemas, handler factory with business logic
- Key files: `src/mcp/handlers.ts` (add new tools here), `src/mcp/registry.ts` (add tool metadata here)

**`src/lib/`:**
- Purpose: Reusable library code shared across the package
- Contains: Drupal MCP HTTP client, utility functions
- Key files: `src/lib/drupal-mcp-client.ts`, `src/lib/utils.ts`

**`src/components/ui/`:**
- Purpose: Radix-UI + Tailwind primitive components for settings/setup pages
- Contains: Button, Input, Badge, Alert, Field, Label, Separator, Textarea, InputGroup
- Generated: No. Committed: Yes.

**`src/__tests__/`:**
- Purpose: Vitest unit tests co-located in a single directory (not alongside source files)
- Contains: Tests for handlers, Drupal MCP client, widget chat tool, content-editor run flow

## Key File Locations

**Entry Points:**
- `src/index.ts`: Package public API — exports `createDrupalModule`, `registerDrupalPrimitives`, `createDrupalPrimitiveHandlers`, `createDrupalWidgetChatTool`, `registerDrupalConnector`, and related types
- `src/settings-page.tsx`: Consumed directly as `@cinatra-ai/drupal-mcp-connector/settings-page` by the host

**Configuration:**
- `package.json`: Package manifest including `cinatra` metadata block (`apiVersion`, `kind`, `requestedHostPorts`)
- `cinatra/plugin.json`: Platform-level connector manifest
- `tsconfig.json`: TypeScript compiler settings
- `vitest.config.ts`: Test runner configuration

**Core Logic:**
- `src/deps.ts`: DI seam — add new host-provided surfaces here
- `src/mcp/handlers.ts`: All tool handler implementations + Zod schemas
- `src/mcp/registry.ts`: Tool descriptions and MCP registration loop
- `src/lib/drupal-mcp-client.ts`: Drupal HTTP transport

**Testing:**
- `src/__tests__/`: All tests live here; one file per logical unit

## Naming Conventions

**Files:**
- `kebab-case.ts` for all source files (e.g., `drupal-mcp-client.ts`, `widget-chat-tool.ts`)
- `kebab-case.tsx` for React component files (e.g., `settings-page.tsx`)
- `kebab-case.test.ts` for test files

**Directories:**
- `lowercase` for all directories (`mcp/`, `lib/`, `components/`, `ui/`)

**Exports:**
- `camelCase` for functions: `createDrupalModule`, `registerDrupalPrimitives`, `callDrupalMcp`
- `PascalCase` for types/interfaces: `DrupalConnectorDeps`, `DrupalWidgetContext`, `DrupalFunctionTool`
- `SCREAMING_SNAKE_CASE` for internal constants: `TOOL`, `TOOL_META`, `MCP_TOOLS_PATH`

**MCP Tool Names:**
- `snake_case` prefixed with `drupal_`: `drupal_node_get`, `drupal_node_update`, `drupal_content_editor_run`

**Zod Schemas:**
- Named `[concept]Schema` in camelCase: `nodeGetSchema`, `nodeUpdateSchema`, `drupalContentEditorRunSchema`

## Where to Add New Code

**New MCP tool:**
1. Add Zod input schema in `src/mcp/handlers.ts` (export it)
2. Add handler function to the record returned by `createDrupalPrimitiveHandlers()` in `src/mcp/handlers.ts`
3. Add tool metadata entry to `TOOL_META` in `src/mcp/registry.ts`
4. Export the schema from `src/mcp/registry.ts` imports if needed externally
5. Add tests: `src/__tests__/handlers.test.ts`

**New host-provided runtime surface:**
1. Add to `DrupalConnectorDeps` interface in `src/deps.ts`
2. Consume via `getDrupalDeps().<newSurface>` in the relevant handler or client

**New UI component:**
- Implementation: `src/components/ui/<component-name>.tsx`
- Follow existing pattern (Radix-UI primitive + `class-variance-authority` + `tailwind-merge`)

**New utility:**
- Shared helpers: `src/lib/utils.ts`

**New test:**
- Location: `src/__tests__/<logical-unit>.test.ts`
- Reset DI in `beforeEach`/`afterEach` using `_resetDrupalDepsForTests()` from `src/deps.ts`

## Special Directories

**`.github/workflows/`:**
- Purpose: CI (`ci.yml`) and release (`release.yml`) automation
- Generated: No
- Committed: Yes

**`.planning/codebase/`:**
- Purpose: GSD codebase analysis documents for orchestrator consumption
- Generated: Yes (by `/gsd-map-codebase`)
- Committed: Yes

---

*Structure analysis: 2026-06-09*
