# Changelog

All notable changes to this project are documented here, derived from the
project's merged pull request and release-tag history.

## Unreleased

- fix(deps): `zod` is now a declared dependency of this package, at `^4.4.3`. It is imported by `src/mcp/handlers.ts`, `src/mcp/registry.ts` and `src/webhooks/node-published.ts` but was listed nowhere, resolving only through the Cinatra host's hoisted root `node_modules` symlink — the last phantom edge of the class the MCP client migration removed. The lower bound is a hard floor rather than a preference, and there are really two of them, both measured across `zod` 3.25.76 / 4.0.0 / 4.1.12 / 4.2.0 / 4.4.3: at runtime a 3.x schema registers cleanly and then fails the *entire* `tools/list` with JSON-RPC `-32603`, so one unconvertible schema takes down every Drupal tool at once, while every 4.x converts; and at compile time 4.0/4.1 stop typechecking against the host's `ExtensionStandardSchema`, which requires the `~standard.jsonSchema` that `zod` first exposes in 4.2.0. The host tree does carry a `zod` 3.x copy alongside the 4.x one, so the bad state is reachable; a new test locks the runtime half against a real MCP server. The range is the host's own rather than an exact pin so that a full resolution lands both on one instance instead of a second copy, and a host bump inside major 4 carries this package along. Nothing about the schemas, the primitives, or the webhook payload validation changes; this closes the resolution gap they were already relying on.

- feat(mcp): the Drupal MCP transport moves to `@modelcontextprotocol/client` 2.0.0, and the dependency is now DECLARED. `src/lib/drupal-mcp-client.ts` previously imported the v1 `@modelcontextprotocol/sdk` without listing it anywhere, resolving only through the Cinatra host's hoisted root `node_modules` symlink — so removing that host-side line broke this package's module resolution. `@modelcontextprotocol/client` is now an exact-pinned entry in this package's own `dependencies`. Protocol-revision negotiation is explicit: `versionNegotiation: { mode: "auto" }`, a typed options object, which prefers MCP revision `2026-07-28` where a Drupal peer answers the `server/discover` probe and falls back to the 2025-era `initialize` handshake where it does not (every peer today, since `drupal/mcp_tools` runs on a PHP MCP SDK that enumerates no 2026 revision). `auto` rather than a fixed legacy setting because Drupal peers are per-instance sites the site owner upgrades. Behaviour is otherwise unchanged: same endpoint, same Nango bearer on every request, same response unwrapping, same error text. The error CLASSES a failed call rejects with do change with the library (`SdkHttpError` / `ProtocolError` in place of `StreamableHTTPError` / `McpError`, without v1's message prefixes); no consumer reads either, and the review gate that refuses a content write on an unavailable read still refuses it.

- refactor(skills): the widget-chat bundle leaves this connector. `skills/drupal-widget-chat/SKILL.md` and the now-purposeless `cinatra/plugin.json` skills pointer are deleted, `skills` drops out of the published `files` list, and the `cinatra.capabilities` declaration of `widget-chat.drupal-content-editor` moves to the package that actually ships the bundle. In its place the manifest declares a required runtime dependency edge on `@cinatra-ai/drupal-widget-chat-skill` (the renamed `@cinatra-ai/drupal-skills`), which has always carried a byte-identical copy of the same prompt — so this change collapses a duplicate rather than relocating a unique file. `cinatra.widgetStream.skillCapability` is unchanged: the connector still NAMES the capability its widget needs, and the skill package now solely PROVIDES it. Required by the packaging contract that bans a skill bundle inside a non-skill extension.

## v0.1.6 — 2026-07-07

Required rider alongside Cinatra 0.1.7: this release takes ownership of Drupal-specific capability code that Cinatra 0.1.7 removes from core, and adds the Drupal publish-notification receiver.

- feat(widget-auth): own the Drupal widget-auth store and register the capability — on a Cinatra 0.1.7 host, widget sessions on connected sites need this version (#58)
- feat(webhooks): `cinatra.webhooks` declaration and handler for the Drupal node-published event on the host's generic webhook route, with per-binding secret verification host-side; pairs with Drupal module 0.1.6 (#54)
- feat: bundle the Drupal widget-chat skill in the install closure so fresh installs no longer boot with an unresolved widget-chat capability, and align the content-editor dispatch payload to the WordPress object shape (#56)
- feat(instances): own the relocated Drupal instance-settings client, registered under its host capability (#59)
- feat(dev-setup): dev-mode provisioning moves into a connector-owned `devSetup` hook (#55); the dev fixture probe runs in-container, dropping the `node:fs` host precheck (#57)

## v0.1.5 — 2026-07-04

- feat: final connection access-scoping declaration — default scope "workspace" (#53)
- feat(mcp): declare the mcp.json primitive surface for the Drupal MCP tools (#51)
- fix(security): redact the Nango credential binding from `drupal_instances_list` (#50)
- chore(deps): declare `cinatra.consumes` for closure-gate enrollment (#49)
- docs/ci: CHANGELOG derived from tag and merged-PR history (#52); release workflow pinned to the gated reusable extension-release flow (release-approval wall) (#48)

## v0.1.4 — 2026-06-28

- fix: declared `cinatra.vendor` identity ahead of a marketplace re-submit (#45)
- chore: stripped private tracker references from public source (#39)

## v0.1.3 — 2026-06-28

- feat: shipped the MCP toolbox/register module (release #40)
- fix: actor-scoped tool injection via host authority, fail-closed; shadcn raw-element fixes and ramped the UI gate to error (#34, #35)
- docs: expanded README to the org standard (#33)
- ci: re-vendored the UI-gate preset with the dynamic-import ban; adopted source-leak-gate (#38, #36, #37)

## v0.1.2 — 2026-06-23

- feat: full-field JSON:API read so the Drupal agent emits field-level diffs; enforced per-user/per-instance write authority in the Drupal MCP write handlers (#27, #30)
- feat: declared `relayAgentPackage` for the content-editor relay; passed `packageName` for production OBO identity (#22, #21)
- ci: added the truthful-attribution gate (WARN mode); adopted the reusable extension→host IoC conformance gate, the tag-driven GitHub release workflow, and secret-scan-gate (#19, #20, #23, #24)

## v0.1.1 — 2026-06-13

- feat: shipped the external-MCP toolbox module and capability marker; declared the widget-stream surface (`cinatra.widgetStream`); declared the package exports map (incl. `./register`) for the serverEntry builder (#6, #7, #14)
- chore: adopted source-leak-gate, SHA-pinned org gate callers, npm packaging hygiene, Renovate config, reusable release-workflow pinning (#1–#5, #8, #9, #11–#13, #16, #17)

## v0.1.0 — 2026-06-03

- Initial release.

## Unreleased

- feat: declared `cinatra/mcp.json` for the Drupal MCP primitive surface (#51)
- fix: redacted the Nango credential binding from `drupal_instances_list` (#50)
- chore: stripped private tracker references from workflow comments; backfilled `cinatra.sdkAbiRange`; pinned the reusable extension-release workflow to the gated version (release-approval wall); declared `cinatra.consumes` for closure-gate enrollment (#46, #47, #48, #49)
