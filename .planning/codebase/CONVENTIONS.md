# Coding Conventions

**Analysis Date:** 2026-06-09

## Naming Patterns

**Files:**
- `kebab-case` for all source files: `drupal-mcp-client.ts`, `widget-chat-tool.ts`, `settings-page.tsx`
- Test files in `src/__tests__/` with `.test.ts` suffix: `handlers.test.ts`, `drupal-mcp-client.test.ts`
- UI component files in `src/components/ui/` are also kebab-case: `input-group.tsx`, `alert.tsx`

**Functions:**
- `camelCase` for all functions and methods
- Factory functions use `create` prefix: `createDrupalPrimitiveHandlers()`, `createDrupalModule()`, `createDrupalWidgetChatTool()`
- Registration functions use `register` prefix: `registerDrupalConnector()`, `registerDrupalPrimitives()`
- Getter DI functions use `get` prefix: `getDrupalDeps()`
- Test-only internal helpers use `_` prefix: `_resetDrupalDepsForTests()`

**Variables/Constants:**
- `camelCase` for regular variables and function parameters
- `SCREAMING_SNAKE_CASE` for module-level constant objects: `TOOL` object in `src/mcp/handlers.ts`
- `SCREAMING_SNAKE_CASE` for named tool string constants in tests: `DRUPAL_NODE_GET_TOOL`, `DRUPAL_NODE_UPDATE_TOOL`

**Types/Interfaces:**
- `PascalCase` for all interfaces and types
- Exported interfaces use `interface` keyword: `DrupalConnectorDeps`, `DrupalDispatchContentEditorInput`
- Zod schemas suffixed with `Schema`: `instanceIdSchema`, `nodeGetSchema`, `nodeUpdateSchema`

**Exports:**
- Named exports only — no default exports detected

## Code Style

**Formatting:**
- No `.prettierrc` or `biome.json` detected in repo root
- TypeScript strict mode enabled in `tsconfig.json`
- `noImplicitAny: false` — type inference is used broadly
- `verbatimModuleSyntax: true` — `import type` used for type-only imports throughout

**Linting:**
- No `.eslintrc` detected in repo root; linting configuration likely inherited from the parent monorepo context
- ESM-only package (`"type": "module"` in `package.json`)

## Import Organization

**Order (observed pattern):**
1. `"server-only"` marker import when required (server-side modules)
2. External SDK/library imports (e.g., `@modelcontextprotocol/sdk/...`, `zod`)
3. Host app path alias imports (`@/lib/...`)
4. Relative package imports (`../deps`, `../lib/drupal-mcp-client`)

**Path Aliases:**
- `@/` → repo root `src/` (resolved via `vitest.config.ts` alias — used in production source to reference host app code)
- Package self-referencing aliases (`@cinatra-ai/drupal-mcp-connector/mcp-handlers`) configured in `vitest.config.ts`

**Import Type Syntax:**
- `import type { ... }` used consistently for type-only imports: e.g., `import type { DrupalConnectorDeps } from "./deps"`
- `import { type Foo, bar }` used when mixing type and value imports

## Error Handling

**Patterns:**
- Errors thrown as `new Error("descriptive message")` with lowercase message text (matches `/instance not found/i`, `/not found/i`, `/all submitted fields were empty/i` in tests)
- Error messages NEVER include secrets or tokens — only labels and safe identifiers: `"credential unavailable for site ${instance.siteUrl}"` (URL, not token)
- DI guard throws synchronously: `getDrupalDeps()` throws if deps not registered at boot
- `client.close()` called in `finally` block with `.catch(() => {})` to suppress close errors: `src/lib/drupal-mcp-client.ts`
- Zod validation at handler entry: parse throws with structured zod errors; callers receive the zod error object directly
- Graceful fallback on JSON.parse failure: `content-editor-run` returns `{ result: text }` instead of throwing

## Logging

**Framework:** Not detected — no logger import found
**Patterns:** No structured logging in source files; error label passed to `buildNangoBearerHeader` as `label` field for external (host-side) warn-only logging

## Comments

**When to Comment:**
- Inline `//` comments used extensively to document non-obvious design decisions, especially around DI seams, security choices, and external API quirks
- Long block comments before functions explaining the "why" (example: the `DRUPAL_DEPS_KEY` comment block in `src/deps.ts`)
- Test files include block comments at the top describing the test suite's behavioral contract and scope (e.g., `D1:`–`D5:` labels in `widget-chat-tool.test.ts`)
- Tool name constants annotated with discovery date and Drupal version context: `// Actual tool names discovered 2026-04-27 against Drupal 11 + mcp_tools ^1.0@beta`

**JSDoc/TSDoc:**
- JSDoc-style `/** */` used on exported public-surface types and functions, e.g., `DrupalDispatchContentEditorInput`, `DrupalNangoBearerHeaderInput`
- `@internal` tag used for test-only exports: `/** @internal test-only. */`

## Function Design

**Size:** Functions are focused and small; handlers follow a consistent read-validate-call-return pattern
**Parameters:** Single object parameter for handler calls matching `ExtensionPrimitiveRequest` shape; DI registration functions take a single typed deps object
**Return Values:** Handlers return `Promise<unknown>`; DI registration returns `void`; `getDrupalDeps()` returns the typed deps or throws (never returns null)

## Module Design

**Exports:** `src/index.ts` re-exports all public surfaces; settings/setup pages are imported directly by consumers via entry path (noted in comment)
**Barrel Files:** `src/index.ts` acts as the main barrel; no nested barrel files within subdirectories
**DI Pattern:** Host dependencies registered on `globalThis` via `Symbol.for(...)` namespaced key to survive separate Next.js bundle compilation boundaries (`src/deps.ts`)

## TypeScript Specifics

**Strict Mode:** `strict: true` with `noImplicitAny: false` — explicit `any` casts used sparingly (e.g., `(handlers as any).drupal_node_get(...)` in tests to access handler map by string key)
**Zod for Runtime Validation:** All MCP handler inputs validated via Zod schemas defined in `src/mcp/handlers.ts`; schema objects are named exports for test reuse

---

*Convention analysis: 2026-06-09*
