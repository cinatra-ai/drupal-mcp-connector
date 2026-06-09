# Testing Patterns

**Analysis Date:** 2026-06-09

## Test Framework

**Runner:**
- Vitest (version not pinned in `package.json` devDependencies — inherited from monorepo)
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest built-in (`expect` from `vitest`)

**Run Commands:**
```bash
npm test           # Run all tests (runs vitest)
```

Watch and coverage commands are not defined in `package.json` scripts; run via `npx vitest --watch` or `npx vitest --coverage` if needed.

## Test File Organization

**Location:** Co-located in `src/__tests__/` directory (separate subdirectory, not alongside source files)

**Naming:** `<subject>.test.ts` — no `.spec.ts` files detected

**Structure:**
```
src/
└── __tests__/
    ├── handlers.test.ts              # createDrupalPrimitiveHandlers() — MCP primitives
    ├── drupal-mcp-client.test.ts     # callDrupalMcp() — HTTP transport + response parsing
    ├── content-editor-run.test.ts    # drupal_content_editor_run reply-text handling
    └── widget-chat-tool.test.ts      # createDrupalWidgetChatTool() — security + shape
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// vi.mock() calls hoisted before all other imports
vi.mock("@/lib/drupal-api", () => ({ listDrupalInstances: vi.fn(), getDrupalAPIStatus: vi.fn() }));
vi.mock("../lib/drupal-mcp-client", () => ({ callDrupalMcp: vi.fn() }));

// Real imports after mocks
import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "@cinatra-ai/drupal-mcp-connector/mcp-handlers";

describe("createDrupalPrimitiveHandlers", () => {
  let handlers: ReturnType<typeof createDrupalPrimitiveHandlers>;

  beforeEach(() => {
    handlers = createDrupalPrimitiveHandlers();
    vi.mocked(listDrupalInstances).mockReset();
    vi.mocked(callDrupalMcp).mockReset();
  });

  it("does something specific", async () => {
    vi.mocked(listDrupalInstances).mockResolvedValue([inst()]);
    vi.mocked(callDrupalMcp).mockResolvedValue({ content: [...] });
    const result = await (handlers as any).drupal_node_get({ ... });
    expect(result).toMatchObject({ id: "5" });
  });
});
```

**Patterns:**
- `beforeEach` used for handler instantiation and mock reset; never `beforeAll`
- `afterEach` used exclusively for DI teardown: `_resetDrupalDepsForTests()`
- Each `it()` registers only the mock behavior it needs for that case
- Test names describe behavior contracts, not implementation: `"strips Markdown code fences before JSON.parse"`

## Mocking

**Framework:** Vitest `vi.mock()` + `vi.fn()`

**Module Mocking Pattern:**
```typescript
// Always at top of file, before imports — Vitest hoists these
vi.mock("@/lib/drupal-api", () => ({
  listDrupalInstances: vi.fn(),
  getDrupalAPIStatus: vi.fn(),
}));
vi.mock("../lib/drupal-mcp-client", () => ({
  callDrupalMcp: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // Regular function required — arrow functions cannot be used with `new`
  Client: vi.fn().mockImplementation(function () {
    return { connect: mockConnect, callTool: mockCallTool, close: mockClose };
  }),
}));
```

**Per-test mock behavior:**
```typescript
vi.mocked(listDrupalInstances).mockResolvedValue([inst({ id: "a" })]);
vi.mocked(callDrupalMcp).mockResolvedValue({ content: [{ id: "5", title: "Hi" }] });
// One-time override:
buildNangoBearerHeader.mockResolvedValueOnce(null);
```

**What to Mock:**
- All external module boundaries: `@/lib/drupal-api` (host app DB layer), `@cinatra-ai/nango-connector` (via DI seam, not direct mock)
- MCP SDK classes: `@modelcontextprotocol/sdk/client/index.js` and `streamableHttp.js`
- Host DI deps (`dispatchContentEditor`, `buildNangoBearerHeader`) via `registerDrupalConnector()` stub — NOT via `vi.mock`

**What NOT to Mock:**
- The connector's own source modules under test (handlers, widget-chat-tool)
- Zod schemas — test validates real zod rejection behavior
- `src/deps.ts` DI registration — tests call real `registerDrupalConnector()` and `_resetDrupalDepsForTests()`

## DI Stub Pattern

Tests that touch the host-bound DI deps (`dispatchContentEditor`, `buildNangoBearerHeader`, `decodeCursor`, `buildListPage`) use a local registration helper rather than `vi.mock`:

```typescript
const dispatchMock = vi.fn(
  async (_input: { agentUrl: string; payload: string; timeoutMs: number }) => "",
);

function registerDepsStub() {
  registerDrupalConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: dispatchMock,
    buildNangoBearerHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
  });
}

afterEach(() => {
  _resetDrupalDepsForTests();
});
```

This pattern is used in `handlers.test.ts`, `content-editor-run.test.ts`, and `widget-chat-tool.test.ts`.

## Fixtures and Factories

**Test Data — Instance Factory:**
```typescript
const inst = (over: Partial<{
  id: string; name: string; siteUrl: string;
  nangoConnectionId: string; providerConfigKey: string;
}> = {}) => ({
  id: over.id ?? "site-1",
  name: over.name ?? "Site 1",
  siteUrl: over.siteUrl ?? "http://localhost:8082",
  nangoConnectionId: over.nangoConnectionId ?? over.id ?? "site-1",
  providerConfigKey: over.providerConfigKey ?? "cinatra-drupal",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
```

`inst()` is defined independently in both `handlers.test.ts` and `drupal-mcp-client.test.ts` (not shared via a fixture file).

**Location:** No shared fixture directory; factories are defined inline per test file.

## Vitest Resolver Configuration

`vitest.config.ts` sets up critical path aliases required for tests to work:

- `server-only` → stub at `tests/__stubs__/server-only.ts` (monorepo root)
- `@cinatra-ai/a2a` → stub at `tests/__stubs__/cinatra-a2a.ts` (avoids DB deps)
- `@cinatra-ai/drupal-mcp-connector/mcp-handlers` → `src/mcp/handlers.ts` (self-referencing)
- `@cinatra-ai/drupal-mcp-connector/widget-chat-tool` → `src/widget-chat-tool.ts` (self-referencing)
- `@/` → monorepo `src/` directory

Tests depend on stubs in the monorepo root (`../../..` relative to package root).

## Coverage

**Requirements:** Not enforced — no `coverage` threshold in `vitest.config.ts`
**View Coverage:** Not applicable — no coverage script defined

## Test Types

**Unit Tests:**
- All tests are unit tests with mocked dependencies
- Test individual handler functions and the `callDrupalMcp` transport function
- Four test files covering: MCP primitive handlers, HTTP client, content editor dispatch, widget tool

**Integration Tests:** Not detected

**E2E Tests:** Not detected

## Common Patterns

**Async Testing:**
```typescript
// Standard async/await
it("does something async", async () => {
  vi.mocked(callDrupalMcp).mockResolvedValue({ ok: true });
  const result = await (handlers as any).drupal_node_publish({ ... });
  expect(callDrupalMcp).toHaveBeenCalledWith(...);
});
```

**Error Testing — rejects.toThrow with regex:**
```typescript
it("throws when instance not found", async () => {
  await expect(
    (handlers as any).drupal_node_get({ ... }),
  ).rejects.toThrow(/instance not found/i);
});

// Asserting side effects after expected throw
it("throw fires BEFORE MCP call", async () => {
  await expect(...).rejects.toThrow(/all submitted fields were empty/i);
  expect(callDrupalMcp).not.toHaveBeenCalled();
});
```

**Argument Inspection Pattern:**
```typescript
// Destructure the mock call args array
const [, , args] = vi.mocked(callDrupalMcp).mock.calls[0];
expect((args as any).updates).toEqual({ title: "T", featured: false });
expect((args as any).updates).not.toHaveProperty("body");
```

**Security Invariant Testing:**
Tests explicitly assert that LLM-supplied fields cannot override security-critical context values (see `widget-chat-tool.test.ts` D2 test) and that error messages do not leak tokens (see `drupal-mcp-client.test.ts` credential-unavailable test).

**Handler Map Access:**
Handlers are accessed as `(handlers as any).drupal_node_get(...)` — the `any` cast is intentional to access the handler map by string key without requiring a typed index signature on the return type.

---

*Testing analysis: 2026-06-09*
