# connector-drupal — AGENTS.md

Package-specific guidance for `@cinatra-ai/drupal-connector`. Read alongside the repo-root `AGENTS.md`.

## Package role

Exposes 9 MCP primitives that proxy to the `drupal/mcp_tools` Streamable HTTP endpoint (`/_mcp_tools`) on each configured Drupal site (plus an A2A blocking dispatch primitive `drupal_content_editor_run`). Also provides the `DrupalSettingsPage` RSC for `/configuration/llm/drupal` and wires into `src/lib/mcp-server.ts` via `createDrupalModule()`.

## Primitive names and tool name mapping

The Cinatra primitive names (what the LLM calls) map to `drupal/mcp_tools` tool names (what the MCP client sends):

| Cinatra primitive | drupal/mcp_tools tool | Notes |
|---|---|---|
| `drupal_status` | — | Local status check, no MCP call |
| `drupal_instances_list` | — | Reads from DB; returns rows verbatim; credentials live only in the Nango vault and are resolved at call time |
| `drupal_node_get` | `mcp_jsonapi_list_entities`; `cinatra_read_protected_revision` only when that call throws; `mcp_tools_get_recent_content` when that call returns no node or the module read fails too | The module reader serves an endpoint that lists only the Cinatra module tools; it is not tried when the generic read answers without the node. **No get-by-ID tool exists** — pulls the recent-content list and finds the node by `id` / `nid`; `mcp_tools_search_content` requires ≥3-char queries and does not support nid-specific lookup |
| `drupal_node_read_for_edit` | `cinatra_read_protected_revision` without `revision_id`, only | The read a bound edit starts from: every editable field value and the module's `binding`. Declared `passthroughStep: "read"`, no `outward`. Writes nothing |
| `drupal_node_update` | `mcp_update_content`; with `expectedBinding`: `cinatra_read_protected_revision` (field structure) + `cinatra_write_unpublished` | `nid` sent as a string (PHP `strtolower()` type fix); maps `fields` input → `updates` arg |
| `drupal_node_create_draft_revision` | `cinatra_read_protected_revision` + `cinatra_write_protected_draft` in the existing Cinatra module | SAME nodeId + fields + optional exact language; atomic draft and independent exact-revision readback. With `expectedBinding` the writer gets the binding's values |
| `drupal_node_list` | `mcp_tools_get_recent_content` | Returns `{ total, sorted_by, content: [...] }`; the handler unwraps the `content` array |
| `drupal_node_publish` | `mcp_publish_content`; with `expectedBinding`: `cinatra_publish_unpublished`, or with `fields` as well `cinatra_read_protected_revision` + `cinatra_write_unpublished` with `publish: true` | `nid` sent as a string + `publish: true` |
| `drupal_content_editor_run` | — | A2A blocking dispatch to `wayflow-drupal-content-editor` (port 3020). Not an `mcp_tools` call |

Tool names were discovered by inspecting a live Drupal 11 + `drupal/mcp_tools ^1.0@beta` instance in 2026-04. The live instance exposed 29 tools.

## Writes bound to the reviewed read (cinatra#3745, owner decision 1234 A)

A flow edits a page without a model: `drupal_node_read_for_edit` reads it, a person reviews the change, and one publishing step writes it with the read's `binding`. The write happens only if the page is unchanged since that read.

- `binding` (`src/integration/edit-binding.ts`, `EditBinding`) holds the module members `nid`, `language`, `expected_default_revision_id`, `expected_latest_revision_id`, `expected_changed`, `workflow_fingerprint`, `preimage_fingerprint`, named exactly as the module's inputs, plus the connector's own `instanceId` (the connector instance the page was read from), `target`, `targetUpdatedAt` and `published`. `target` is `siteTarget` of the instance's site URL at the read: `<scheme>://<host>[:<port>]<base path>`, scheme and host lower-cased, default port dropped, no user name or password, no query or fragment, no trailing slash; never a credential. `targetUpdatedAt` is the instance row's `updatedAt` at the read (null when the row has none), an addition only. Drupal's site UUID is not used: a clone copies it. A flow passes the object on unchanged; `moduleBindingArgs` strips the four connector members before a module call. `preimage_fingerprint` covers every translation's stored values and names the bound translation. The read also returns `instanceId` at the top level for the flow's later steps.
- The write tools take it as `expectedBinding` (or `expectedBindingJson`). The connector checks only its shape (every member, its type, a non-empty `instanceId`, no other member) and that its instance, node and language are the call's, and refuses otherwise with `invalid_binding` before any call. A bound write resolves the instance row once (`boundInstanceAndAuthority`) and refuses with `invalid_binding`, before any site call, unless that row's target and `updatedAt` equal the binding's; the same row object then serves every call (`callDrupalMcp` and `listDrupalMcpToolNames` take the URL from `instance.siteUrl`). So a binding read from one instance never writes another, nor the same instance id reconfigured to another site (a clone with the same revisions and fingerprints included). The Cinatra module compares the values under the node lock.
- Unpublished page: `drupal_node_update` writes through `cinatra_write_unpublished`; `drupal_node_publish` publishes through `cinatra_publish_unpublished`, and with `fields` it writes and publishes in one save (`cinatra_write_unpublished` with `publish: true`). Publishing stays on `drupal_node_publish`, the tool declared `outward`; `drupal_node_update` refuses `publish: true`. Published page: `drupal_node_create_draft_revision` passes the binding's revision ids and fingerprints to `cinatra_write_protected_draft` in place of its own fresh read, which then only supplies the draft state and the stored item structure.
- A bound write never falls back to `mcp_update_content` / `mcp_publish_content`. Before any module call it reads the site's tool list (`listDrupalMcpToolNames`) and requires every module tool of its path (`MODULE_TOOLS` in `src/mcp/handlers.ts`: the read, write, publish and draft paths); a missing one refuses with `module_capability_missing` naming it. A path makes its module calls only through the caller `moduleTools` returns, which refuses a tool outside that list, so a call and its gate cannot drift. A bound draft also needs `cinatra_write_unpublished`, the marker of the module version that binds the translation.
- Without `expectedBinding` every tool behaves as before. `fields` / `fieldsJson` and `expectedBinding` / `expectedBindingJson` are exclusive pairs; the JSON text is bounded at `JSON_ARGUMENT_MAX_BYTES` (256 KiB, UTF-8 bytes), must be a plain object, and is refused with fixed messages that never repeat the text.
- Refusals are thrown as `<code>: <fixed text>` and never repeat page content or the site's text (`mapModuleWriteFailure`):

  | Code | Cause |
  |---|---|
  | `node_changed` | the module's changed revision, changed time, workflow, values or publication refusals; a pending revision when the read had none; on a bound draft also the connector's own reads showing the page unpublished, a new pending revision, content changed between its reads, or a changed `expectedFields` |
  | `pending_revision` | a pending revision that already existed at the read |
  | `permission_denied` | the module's edit, publish, workflow-state, field-access or MCP-permission refusals |
  | `invalid_input` | the module's request-shape, unknown-field, invalid-value or text-format refusals; a scalar edit the stored structure cannot take; no non-empty field, a system field, or an unknown instance |
  | `refused` | any other module refusal text; a bound draft the module read does not allow (not moderated, no single draft state) |
  | `write_unverified` | a failure that is not a module refusal, the module's "inspect before retrying" failures, or a result that is not the expected stored revision |
  | `permission_denied` (connector) | the host's write-authority gate denied the person |
  | `invalid_binding`, `wrong_page_state`, `module_capability_missing`, `read_unavailable` | connector checks before any write |

  A write tool decides first whether the call is bound (either binding form present, before anything is parsed). A bound call runs inside `runBound` (`src/integration/edit-binding.ts`), the one place that codes every exit: a coded refusal passes; any other error becomes `write_unverified` once the write call was sent, `refused` after an earlier site call, and before any call `invalid_binding` for the binding arguments, else `invalid_input`, with fixed texts that never repeat the input. For this the three write tools register a schema that publishes the same JSON Schema on tools/list but accepts any value on a bound call (`handlerValidated` in `src/mcp/registry.ts`); the handler parses with the real schema. An unbound call is validated by the server as before: with the real schema, and on update and draft with `fields` required unless `fieldsJson` is given, so it gets the same "Input validation error" texts. Without a binding each tool keeps its existing message. On the bound protected draft an unverified failure is `write_unverified` with the "inspection required" text.
- `PASSTHROUGH_STEPS` in `src/mcp/registry.ts` declares `passthroughStep: "read"` on `drupal_node_read_for_edit` and `"publishing"` on the three write tools. A host that reads the field serves a "read" tool to a verified flow step with no person's decision (only on a registration with no `outward`), and a "publishing" tool only to a publishing step whose card a person released. Never declare "read" on a tool that can reach a write.

## Key implementation invariants

### Generic MCP tools use string `nid`; Cinatra module tools use integer `nid`

`mcp_update_content` and `mcp_publish_content` both validate the `nodeId` as a positive integer, then re-stringify before dispatch. The Cinatra primitive receives `nodeId` as a string (from JSON); the handler parses it to a number to reject non-numeric input, then sends `String(nid)` over the wire because `drupal/mcp_tools ^1.0` calls PHP `strtolower()` on the `nid` field and rejects non-string types:

```typescript
const nid = parseInt(nodeId, 10);
if (!Number.isFinite(nid) || nid <= 0) {
  throw new Error(`Invalid nodeId: "${nodeId}" is not a positive integer`);
}
return callDrupalMcp(instance, TOOL.UPDATE, { nid: String(nid), updates: safeFields });
```

The Cinatra module reader/writer have integer Tool API inputs: validate a safe positive integer and dispatch integer `nid` on that path. The generic third-party string workaround does not apply to them.

Sending `NaN` (from `parseInt("abc", 10)`) would otherwise serialise as `null` in JSON and produce an opaque error from Drupal — the parseInt step is purely a validation gate; the actual wire value is the string form.

### `drupal_node_update` — `fields` maps to `updates`, not `fields`

The input schema uses `fields: Record<string, unknown>`. The MCP tool expects `updates: Record<string, unknown>`. The mapping happens in the handler:

```typescript
callDrupalMcp(instance, TOOL.UPDATE, { nid, updates: input.fields });
```

Do not pass `fields` directly — `mcp_update_content` ignores unknown keys silently.

### `drupal_node_get` is a recent-list proxy, not a true read-by-id

`drupal/mcp_tools` has no get-node-by-ID tool. The handler calls `mcp_tools_get_recent_content` with `{ limit: 100 }` and finds the matching node by walking the returned `content` array, matching on `id` or `nid`. `mcp_tools_search_content` requires ≥3-char queries and does not support nid-specific lookup. This means:

- Only nodes inside the recent 100 entries are reachable; older nodes throw `Node {nid} not found in recent 100 nodes via mcp_tools_get_recent_content`.
- The MCP envelope returned by `callDrupalMcp` has shape `{ total, sorted_by, content: [...] }`; the handler unwraps `content` and locates the node by numeric equality on either `id` or `nid`.
- There is no `TOOL.READ` constant today (`drupal/mcp_tools` exposes no read-by-ID); a read-by-ID would need a new constant in the `TOOL` map in `handlers.ts` (e.g. `READ`) plus the corresponding test constant in `handlers.test.ts`.

### Bearer-only auth

`DrupalInstanceSettings` does not carry `mcpApiKey`. The Bearer token (generated by `drupal/mcp_tools`'s remote key endpoint) lives ONLY in the Nango vault, keyed by `nangoConnectionId` (== `instance.id`) under the `cinatra-drupal` integration (`provider: private-api-bearer`). The instance row carries `nangoConnectionId` + `providerConfigKey` (pointers, not secrets). The token is resolved at call time via `buildBearerAuthHeaderFromNango` in `callDrupalMcp` / `buildDrupalMcpServerTools` / `getDrupalMcpInstanceStatuses`. There is no username/password or cookie auth. Never add username/password fields and never re-introduce a plaintext key field.

### `mcpApiKey` stripped from `drupal_instances_list` response

There is no credential field in the instance row to strip — `drupal_instances_list` returns rows verbatim. The Bearer token lives only in the Nango vault and is resolved at call time via `buildBearerAuthHeaderFromNango` (keyed by `instance.nangoConnectionId`). The LLM only ever sees `id`/`name`/`siteUrl`/`nangoConnectionId`/`providerConfigKey` — no secret material.

## MCP transport

`callDrupalMcp` in `src/lib/drupal-mcp-client.ts` uses the `@modelcontextprotocol/client` `Client` + `StreamableHTTPClientTransport`. The package is exact-pinned `2.0.0` in this repo's own `dependencies`; the v1 `@modelcontextprotocol/sdk` is gone from this package and is not a route to MCP revision `2026-07-28` at all. A new connection is opened and closed per call (no persistent session). The endpoint is `<siteUrl>/_mcp_tools`.

Protocol-revision negotiation is EXPLICIT, not implicit: the client is constructed with `versionNegotiation: DRUPAL_MCP_VERSION_NEGOTIATION`, a typed `VersionNegotiationOptions` constant holding `{ mode: "auto" }`. It is typed rather than an inline literal on purpose — the option is read as `options?.mode ?? "legacy"`, so a bare `versionNegotiation: "auto"` string silently lands on the legacy era with nothing reporting it; the constant's type makes that a compile error at the call site. Do not weaken it to a fixed `{ mode: "legacy" }`: Drupal peers are per-instance sites their owners upgrade, so the era has to be settled per peer rather than once in this source.

Do not replace this with hand-rolled `fetch` + JSON-RPC body — the library manages session IDs (assigned by the peer on the legacy leg, stored and replayed by the transport), the revision handshake, and transport framing.

## Third-party dependencies must be declared here, and `zod` has a range rule

Every third-party package this repo imports belongs in its own `package.json`. Host-internal `@cinatra-ai/*` packages are the ONE exception — those stay optional `peerDependencies`, because they live only in the cinatra monorepo and CI fails the repo if one leaks into `dependencies`. Anything else that resolves "for free" is resolving through the host's hoisted root `node_modules` symlink, which pnpm publishes only for a direct dependency of the ROOT importer: a phantom edge that breaks the moment the host drops its own line.

That rule is now fully satisfied. `class-variance-authority`, `clsx`, `radix-ui`, `tailwind-merge`, `react`/`react-dom` were already declared; `@modelcontextprotocol/client` and `zod` closed the first phantom edges (#82/#83); `server-only`, `lucide-react`, `next`, and `vitest` close the last four (#86, below). Do not assume a future import resolving today means it is declared — check, and add it here rather than letting it ride the host's hoist.

- **`server-only` → `dependencies`, `^0.0.1`.** Imported for its side effect (throws if a server-only module lands in a client bundle) in three production files — `src/lib/drupal-mcp-client.ts`, `src/mcp/toolbox.ts`, `src/settings-page.tsx` — all three of which ship in the published `files` payload (`npm pack --dry-run` lists all three). `dependencies`, not `devDependencies`: it is a production import, not a test/build-time-only one. `^0.0.1` matches the cinatra host's own range (there has only ever been one `0.0.1` release, so the caret is effectively an exact pin either way).
- **`lucide-react` → `dependencies`, `^1.20.0`.** Production import of `LinkIcon` in `src/settings-page.tsx`. `^1.20.0` matches the cinatra host's current range (and every sibling extension declaring `lucide-react` uses the same `dependencies` shape) — icon components carry no single-instance requirement across the connector/host boundary, so this is a convergence convention rather than a correctness constraint.
- **`next` → `peerDependencies`, `^16.2.9`, required (not optional).** `src/settings-page.tsx` imports `next/cache`'s `revalidatePath` and `next/link`'s `Link` at runtime — not type-only, despite the type-only `Metadata` import sitting next to them — because the page renders as part of the HOST's own Next.js tree; there is no separately-bundled Next.js runtime for this connector to carry. That makes `next` a peer, the same shape already used for `react`/`react-dom` here and for `next` itself in the sibling `linkedin-oauth-connector` (`^16.2.9`, matching the host's `16.2.10`). Not marked optional in `peerDependenciesMeta` — unlike the host-internal `@cinatra-ai/*` peers, `settings-page.tsx` uses it unconditionally, so an unresolved `next` peer should be loud, not silently degraded.
- **`vitest` → `devDependencies`, `^4.1.10`.** Test-only, every file under `src/__tests__/`. `^4.1.10` matches the cinatra host's own `devDependencies` range and the version the suite already resolves to today via the host's hoisted root — declaring it changes nothing about which `vitest` runs, only closes the phantom edge.

`zod` carries an extra rule on top of being declared. The declared range is `^4.4.3`, and both bounds matter for different reasons:

- **Never widen the lower bound — there are two floors and they differ.** Measured across zod 3.25.76 / 4.0.0 / 4.1.12 / 4.2.0 / 4.4.3, against a real `@modelcontextprotocol/server@2.0.0` and a real `tsc`:

  | zod | `registerTool` typechecks | `tools/list` at runtime |
  |---|---|---|
  | 3.25.76 | no | **fails the whole list, JSON-RPC `-32603`** |
  | 4.0.0 / 4.1.12 | **no** — TS2322 vs `ExtensionStandardSchema` | OK |
  | 4.2.0 and up | yes | OK |

  The **runtime** floor is major 4: a zod 3.x schema registers *cleanly* and then takes down **every** Drupal tool at once the first time a client lists them, and nothing at the registration call site can catch it. The **type** floor is 4.2, where zod first exposes `~standard.jsonSchema` — the property the host's `ExtensionStandardSchema` requires. The host tree really does carry a zod 3.x copy alongside the 4.x one, so the bad state is reachable. `src/__tests__/zod-declaration-contract.test.ts` locks the runtime half against a real MCP server.
- **Do not exact-pin it — a convention, not a correctness cliff.** `^4.4.3` is the cinatra host's own range, character for character, and what all fifteen sibling extensions declaring `zod` use. The host reads these schemas structurally through `~standard`, never via `instanceof`, so a second compatible zod 4.x instance would still work — this is not a single-realm requirement, and pnpm would not guarantee one anyway (a filtered update can move the root importer alone). What matching the host buys is that a full resolution lands both on one instance rather than installing a second copy, and that a host bump inside major 4 carries this package along. `@modelcontextprotocol/client` next door IS exact-pinned, and that is not an inconsistency: it is connector-private and no other importer has an opinion about its version.

A host move to a zod major past 4 has to reconcile this line.

## Tests

Tests live in `src/__tests__/` and use the `vitest.config.ts` at the package root. That config resolves its aliases against `../../..` — the cinatra monorepo root — so the suite runs only in a host-shaped tree, never in a standalone clone of this repo. This repo's own CI knows that and skips install/typecheck/test for source mirrors; the monorepo runs them.

Aliases:

- `server-only` → monorepo `tests/__stubs__/server-only.ts`
- `@cinatra-ai/a2a` → monorepo `tests/__stubs__/cinatra-a2a.ts` (avoids Drizzle/DB deps)
- `@cinatra-ai/drupal-mcp-connector/mcp-handlers` → `src/mcp/handlers.ts`
- `@cinatra-ai/drupal-mcp-connector/widget-chat-tool` → `src/widget-chat-tool.ts`
- `@/` → monorepo `src/`

Run from this package's directory inside the monorepo:

```bash
cd extensions/cinatra-ai/drupal-mcp-connector && pnpm vitest run --no-coverage
```

Avoid hard-coding a per-file or total test count here because it drifts as tests change. The E2E-05 named contract test in `handlers.test.ts` locks the `drupalUrl` fallback (`DRUPAL_CONTENT_EDITOR_A2A_URL` unset → `http://localhost:3020`).

## Adding new primitives

1. Add the `drupal/mcp_tools` tool name constant to the `TOOL` object in `handlers.ts`.
2. Add an input schema (`z.object(...)`) exported from `handlers.ts`.
3. Add the handler function to `createDrupalPrimitiveHandlers()`.
4. Add the tool metadata entry to `TOOL_META` in `registry.ts`.
5. Add a test case to `handlers.test.ts` asserting the correct `callDrupalMcp` arguments.
6. Run `pnpm typecheck` and `pnpm vitest run` from the package root.

## Empty-field injection guard

The `drupal_node_update` and `drupal_node_create_draft_revision` handlers receive `fields: z.record(z.string(), z.unknown())`. Because `fields` is a free-form record, Zod cannot apply per-field `min(1)` guards. If an LLM passes `{ body: "" }` for a field it did not intend to change, Drupal would otherwise apply the empty value literally and wipe that field.

**Defence:** Both handlers strip keys whose value is the literal empty string before planning an edit. Generic update additionally reads the actual node status and refuses a published or unknown-status default. Its unpublished write payload remains:

```typescript
const safeFields = Object.fromEntries(
  Object.entries(input.fields).filter(([, v]) => v !== "")
);
callDrupalMcp(instance, TOOL.UPDATE, { nid: String(nid), updates: safeFields });
```

The filter uses strict equality on `""`, so `null`, `undefined`, `false`, and `0` pass through unchanged — legitimate clears (e.g. boolean field flags) keep working.

**All-empty throw guard.** After the strip filter, both handlers verify that at least one field remains:

```typescript
if (Object.keys(safeFields).length === 0) {
  throw new Error("All submitted fields were empty strings — nothing to update.");
}
```

This prevents the LLM from issuing a no-op MCP call that the agent would otherwise treat as success. Mirrored on the WordPress side as `wordpress_post_update_meta`.

The protected draft primitive takes `nodeId`, required `fields`, optional `language` and optional `expectedFields`; a title-only edit is `{fields:{title:"New title"}}`. An omitted language comes only from the actual node read, never a guessed site default. The obsolete new-node shape is rejected. The site must install the supported existing Cinatra Drupal module and deliberately expose its two tools through its maintained MCP profile; missing contract or permissions fail closed. The module binds actual published preimage, workflow, content and revision identifiers, then saves one unpublished non-default revision atomically. When expectedFields is provided it must match actual stored requested fields; stale earlier reads refuse before the write. The connector dispatches integer node identity and structured values, then independently reads the exact returned revision with the full readable field set. Scalar edits preserve stored format/summary. `pendingDraft.beforeFields` is the bound module preimage; `pendingDraft.fields` and `pendingDraft.revisionId` come from the independent saved read, never a request echo or published-default substitute. Verification failure after writer dispatch reports inspection required and any returned revision identifier; it cannot promise zero writes. Keep MCP-only egress and the existing write-authority gate; no generic live update or separate-node fallback.

This is the deepest deterministic chokepoint between the LLM and the Drupal API. The SKILL.md warning ("Never pass an empty string for a field the user did not ask to change…") remains as an outer prescriptive layer; the runtime filter is the inner backstop. Do not remove the SKILL.md warning — defence-in-depth means each layer behaves as if it is the only one.

The same threat class on the WordPress side is closed by:
- `wordpress_post_update`: typed schema with `content/excerpt: z.string().min(1).optional()` plus a `.refine` requiring at least one editable field, plus a runtime allowlist in `updateWordPressPost`.
- `wordpress_post_update_meta`: a runtime strip filter plus the same all-empty throw guard mirroring the Drupal pattern.

## Widget chat tool factory

`src/widget-chat-tool.ts` exports `createDrupalWidgetChatTool({ context })`:

- Wrapped as an `LlmFunctionTool` and passed to `stream` in `src/app/api/agents/[agentSlug]/stream/route.ts`.
- Security: `instanceId` and `nodeId` are **forcibly overridden** from the server-trusted request context inside `execute()` — any LLM-supplied identity values are dropped. The tool schema only exposes `instructions`.
- Calls `drupal_content_editor_run` in-process (not via MCP network round-trip).

The widget-chat skill lives in the `@cinatra-ai/drupal-widget-chat-skill` extension at `extensions/cinatra-ai/drupal-widget-chat-skill/skills/drupal-widget-chat/SKILL.md` with catalog id `@cinatra-ai/drupal-widget-chat-skill:drupal-widget-chat`. This connector reaches it through the declared runtime dependency edge in `package.json`; it ships no bundle of its own, and `cinatra.widgetStream.skillCapability` names the `widget-chat.drupal-content-editor` capability that the skill package provides.
