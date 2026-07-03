# Changelog

All notable changes to this project are documented here, derived from the
project's merged pull request and release-tag history.

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
