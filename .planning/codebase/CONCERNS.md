# Codebase Concerns

**Analysis Date:** 2026-06-09

## Tech Debt

**`drupal_node_get` uses a full list scan instead of a direct lookup:**
- Issue: `drupal_node_get` fetches the 100 most-recent nodes via `mcp_tools_get_recent_content` and scans them in-process to find the target node, because `drupal/mcp_tools ^1.0@beta` has no get-by-nid primitive. Nodes outside the 100 most-recent are silently unreachable.
- Files: `src/mcp/handlers.ts` (lines 107–137)
- Impact: Hard-coded `limit: 100` cap means older nodes throw "not found" even when they exist. If the Drupal MCP module ever gains a direct-lookup tool this workaround will be stale but not obviously wrong.
- Fix approach: Monitor `drupal/mcp_tools` for a direct nid-lookup primitive; replace the list-scan with a targeted call. Until then, document the 100-node cap clearly in the tool description (it is already noted in comments but not surfaced to LLM callers in the description string).

**`drupal_node_list` uses a sentinel total for pagination:**
- Issue: The real `total` from `mcp_tools_get_recent_content` is not reliable enough for cursor advancement, so the code synthesises a sentinel total (`offset + arr.length + (arr.length === limit ? 1 : 0)`) to decide whether a next page exists.
- Files: `src/mcp/handlers.ts` (line 218)
- Impact: Cursor-based pagination may terminate one page early or late if the upstream count disagrees with the synthetic value. The behaviour is best-effort.
- Fix approach: If `mcp_tools_get_recent_content` starts returning a stable `total` count, consume it directly and remove the sentinel logic.

**`@/lib/drupal-api` is an out-of-package alias resolved only inside the monorepo:**
- Issue: `src/lib/drupal-mcp-client.ts`, `src/mcp/handlers.ts`, and `src/settings-page.tsx` import from `@/lib/drupal-api` — a path alias wired in the monorepo's tsconfig/vitest config. This module does not exist inside this package's `src/lib/`; it is provided only when the repo is mounted into the monorepo workspace.
- Files: `src/lib/drupal-mcp-client.ts` (line 6), `src/mcp/handlers.ts` (lines 6–8), `src/settings-page.tsx` (line 21)
- Impact: The package is NOT standalone-compilable or standalone-testable. CI explicitly skips `install`, `typecheck`, and `test` for this reason (it is classified as a "source mirror"). Any changes to the `drupal-api` shape in the monorepo silently break this connector until the monorepo runs its own tests.
- Fix approach: Either inline the required types from `@/lib/drupal-api` into this package (the `DrupalInstanceSettings` type and the two helper functions), or expose them via a separate published package, removing the cross-boundary alias dependency.

**`src/lib/utils.ts` contains unrelated generic utilities:**
- Issue: `utils.ts` contains application-level helpers (`formatCurrencyMillions`, `quarterLabel`, `getPageNumbers`, etc.) that have no relationship to the Drupal MCP connector. These appear to be copied from the monorepo root `utils.ts` without pruning.
- Files: `src/lib/utils.ts`
- Impact: Dead code increases package size and confuses contributors about what the connector actually uses. Only `cn` and `slugify` are potentially relevant.
- Fix approach: Remove functions that are not imported by any file in this package (`formatCurrencyMillions`, `quarterLabel`, `getPageNumbers`, `firstName`, `asArray`, `compareValues`).

**`drupal_content_editor_run` A2A URL falls back to hardcoded localhost:**
- Issue: The A2A agent URL defaults to `http://localhost:3020` via `process.env.DRUPAL_CONTENT_EDITOR_A2A_URL ?? "http://localhost:3020"`. If the env var is missing in production the connector silently targets a localhost address that will fail or (worse) be open on a misconfigured host.
- Files: `src/mcp/handlers.ts` (line 249)
- Impact: Production deployments without the env var set will fail silently with connection errors rather than a clear misconfiguration message.
- Fix approach: Remove the localhost default; throw an explicit error when the env var is unset in non-development environments, or require the host to provide this URL through the DI `DrupalConnectorDeps` interface.

## Known Bugs

**`drupal_node_get` may misidentify nodes when both `id` and `nid` properties exist with different values:**
- Symptoms: The find predicate checks `Number(obj.id) === nid || Number(obj.nid) === nid` — if a Drupal item has an `id` field that is numeric but not the node ID (e.g. a revision ID), it could match the wrong record.
- Files: `src/mcp/handlers.ts` (lines 126–130)
- Trigger: Depends on the shape `mcp_tools_get_recent_content` returns; not consistently reproducible.
- Workaround: Currently none. The comment says `id` comes from `$node->id()` so in practice it should be the nid, but no assertion enforces this.

## Security Considerations

**A2A URL injected via environment variable, not validated:**
- Risk: `DRUPAL_CONTENT_EDITOR_A2A_URL` is used as-is to construct the outbound A2A request target. A misconfigured or adversarially set env var could redirect internal requests.
- Files: `src/mcp/handlers.ts` (line 249)
- Current mitigation: Only server-side code reads this variable; it is not user-supplied at request time. The host DI seam (`dispatchContentEditor`) owns the actual HTTP call.
- Recommendations: Validate the URL scheme (`https://` in production) at boot time, or move URL resolution fully into the host-bound `dispatchContentEditor` dep so this package never handles raw URLs.

**`noImplicitAny: false` in tsconfig weakens type safety:**
- Risk: `tsconfig.json` sets `"strict": true` but overrides `"noImplicitAny": false`. This allows implicit `any` types to slip through without a compiler error, potentially masking type errors at call boundaries.
- Files: `tsconfig.json`
- Current mitigation: Vitest tests exercise the critical paths; many test files explicitly cast to `any` (e.g. `(handlers as any).drupal_content_editor_run`).
- Recommendations: Enable `noImplicitAny: true` and resolve the resulting type errors. The `any` casts in tests should be replaced with proper typed accessor patterns or exported handler typings.

**Bearer token never logged, but error messages include `siteUrl`:**
- Risk: Low risk today; `siteUrl` is not a secret. However, the error path in `callDrupalMcp` includes the site URL in thrown error messages (`instance.siteUrl`). If error messages are forwarded to untrusted parties they could reveal internal service addresses.
- Files: `src/lib/drupal-mcp-client.ts` (line 33)
- Current mitigation: The code explicitly avoids including the token in error messages (noted in JSDoc).
- Recommendations: Consider replacing the URL in error messages with a label or instance name rather than the raw URL.

## Performance Bottlenecks

**`drupal_node_get` always fetches 100 nodes over HTTP:**
- Problem: Every single-node read requires a full `mcp_tools_get_recent_content` call with `limit: 100`, then an in-process linear scan. No caching.
- Files: `src/mcp/handlers.ts` (line 119)
- Cause: No direct-by-nid lookup available in `drupal/mcp_tools ^1.0@beta`.
- Improvement path: Cache recent-node responses with a short TTL (e.g. 5s) keyed by `instanceId` to avoid redundant fetches within a single chat turn. Alternatively, wait for an upstream direct-lookup primitive.

**Each `callDrupalMcp` call opens and closes a new MCP client connection:**
- Problem: `callDrupalMcp` creates a new `Client` + `StreamableHTTPClientTransport`, calls `connect`, calls the tool, then calls `close` — per invocation. Connection setup overhead is paid on every tool call.
- Files: `src/lib/drupal-mcp-client.ts` (lines 36–86)
- Cause: No connection pooling; the client is not shared across calls.
- Improvement path: Pool or reuse `Client` instances per `(instanceId, siteUrl)` key with idle-timeout teardown, similar to database connection pools.

## Fragile Areas

**Response envelope parsing with multiple fallback branches:**
- Files: `src/lib/drupal-mcp-client.ts` (lines 48–83)
- Why fragile: The code tries `structuredContent` first, then falls back to parsing text content with `"Success.\n{json}"` prefix stripping, then falls back to raw text. Any change to `drupal/mcp_tools` response format silently falls through to the wrong branch.
- Safe modification: Add a structured test for each branch path. Currently `src/__tests__/drupal-mcp-client.test.ts` covers some scenarios but the text-fallback JSON-extraction path (`jsonStart = stripped.search(/[{[]/`)`) has limited coverage.
- Test coverage: Partial — happy path and error envelope are covered; the text-fallback regex path has fewer test cases.

**`listDrupalInstances` linear scan for instance resolution:**
- Files: `src/mcp/handlers.ts` (line 82–86), called from every handler
- Why fragile: Every handler calls `resolveInstance(instanceId)` which calls `listDrupalInstances()` and scans the full array. If this list grows large or the underlying data source is slow, all tool handlers degrade together.
- Safe modification: The `getDrupalDeps()` DI seam owns `listDrupalInstances` via the monorepo alias; changes to that function propagate silently. Any modification to the return shape (e.g. renaming `id`) breaks all handlers.

**Vitest config resolves stubs from paths outside this repo:**
- Files: `vitest.config.ts` (lines 7–8, 11–14)
- Why fragile: The config references `../../..` (the monorepo root) for `server-only` and `@cinatra-ai/a2a` stubs. This path assumption breaks if the connector is moved within the monorepo directory tree.
- Safe modification: If this package is ever relocated, update the relative path calculation in `vitest.config.ts`. Consider making these stub paths configurable.

## Scaling Limits

**`drupal_node_list` pagination cap:**
- Current capacity: Maximum 100 nodes per page (enforced by `nodeListSchema` max).
- Limit: If `mcp_tools_get_recent_content` has its own server-side cap (e.g. 50), requesting 100 silently returns fewer without error, and the sentinel pagination logic miscomputes available pages.
- Scaling path: Discover and document the upstream server-side max; enforce the same cap client-side.

## Dependencies at Risk

**`drupal/mcp_tools ^1.0@beta` (external Drupal module, not a JS package):**
- Risk: This package hard-codes tool names (`mcp_update_content`, `mcp_create_content`, `mcp_tools_get_recent_content`, `mcp_publish_content`) against the beta version. Breaking changes in `^1.0` stable could silently break all tool calls.
- Impact: All MCP tool operations (get, update, create, list, publish) break if tool names change.
- Migration plan: Watch the `drupal/mcp_tools` changelog for stable release. Pin the expected tool names as constants (already done in `TOOL` object in `src/mcp/handlers.ts`) so breakage is localised.

**`@modelcontextprotocol/sdk` — version not pinned in package.json:**
- Risk: The SDK is imported but not listed in `package.json` dependencies (it is a transitive peer dependency resolved by the host). Version drift in the host could change `CallToolResult` shape and break the response parsing logic.
- Files: `src/lib/drupal-mcp-client.ts` (lines 3–4), `package.json`
- Impact: `structuredContent` and `content` field parsing in `callDrupalMcp` could fail if the MCP SDK changes its result type.
- Migration plan: Add `@modelcontextprotocol/sdk` as an explicit peer dependency with a version range, or accept the structural cast risk explicitly in code comments.

## Missing Critical Features

**No retry or timeout on individual MCP tool calls:**
- Problem: `callDrupalMcp` issues a single `client.callTool(...)` with no retry logic and no per-call timeout (only the outer `drupal_content_editor_run` has a 300s budget). Transient Drupal server errors cause immediate failures.
- Blocks: Reliable production use against flaky or overloaded Drupal instances.

**No integration or end-to-end tests:**
- Problem: All tests mock `callDrupalMcp` and `listDrupalInstances`. There are no tests that exercise the actual MCP HTTP transport against a real or mock Drupal server.
- Blocks: Confidence that the URL construction, authentication headers, and response parsing work against the actual Drupal MCP endpoint.

## Test Coverage Gaps

**`src/mcp/registry.ts` has no direct tests:**
- What's not tested: The `registerDrupalPrimitives` registration loop, the `TOOL_META` fallback for unknown handlers, and the `structuredContent` wrapping in the MCP tool result.
- Files: `src/mcp/registry.ts`
- Risk: A registration bug (e.g. mismatched schema/handler name) would not be caught until runtime.
- Priority: Medium

**`src/lib/utils.ts` has no tests:**
- What's not tested: All utility functions including `slugify`, `getPageNumbers`, `compareValues`.
- Files: `src/lib/utils.ts`
- Risk: Low for this connector (most functions appear to be unused dead code), but `slugify` may be used in settings UI.
- Priority: Low

**`src/mcp/module.ts` has no tests:**
- What's not tested: `createDrupalModule()` factory function and its integration with `registerDrupalPrimitives`.
- Files: `src/mcp/module.ts`
- Risk: Low (thin factory); breakage would be caught at host integration time.
- Priority: Low

**No coverage enforcement configured:**
- What's not tested: Vitest coverage thresholds are absent from `vitest.config.ts`. Coverage is not collected or reported in CI.
- Files: `vitest.config.ts`, `.github/workflows/ci.yml`
- Risk: Coverage can silently regress as the codebase grows.
- Priority: Medium — add `coverage.thresholds` to vitest config for at least the `src/mcp/` and `src/lib/drupal-mcp-client.ts` paths.

---

*Concerns audit: 2026-06-09*
