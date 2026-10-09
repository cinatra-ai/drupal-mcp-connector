# Drupal MCP

Read and explicitly publish Drupal content from Cinatra agents. Update unpublished nodes. Save a published-page edit as a draft revision of the SAME node; the live page stays unchanged until published.

**Install:** add the connector from the Cinatra marketplace. Install `drupal/mcp_tools ^1.0` on Drupal and expose `/_mcp_tools` to Cinatra. Create a Nango `cinatra-drupal` connection (provider: `private-api-bearer`); register each site URL and connection ID in **Settings → Integrations → Drupal**. Published-page edits also need the Cinatra Drupal module's protected draft tools and Content Moderation.

**Usage:** discover sites with `drupal_instances_list`; ask an agent to read nodes, update unpublished fields or publish explicitly. `drupal_content_editor_run` accepts plain-language edits.

**Configuration:** supply `siteUrl` and `nangoConnectionId` per instance. Bearer tokens stay in the Nango vault and are resolved at call time.

**Architecture:** the connector owns the MCP client, instance settings and activation of drupal-mcp/widget-auth capabilities. Its `cinatra.devSetup` hook provisions the local fixture.

**API notes:** `drupal_node_get` reads fields via MCP, falling back to recent-content summaries. `drupal_node_update` reads actual status and refuses published or unknown-status nodes. `drupal_node_create_draft_revision` accepts `instanceId`, `nodeId`, `fields` for the SAME node, never a stray new page or live-default write. It reads via `cinatra_read_protected_revision`, saves once via `cinatra_write_protected_draft` and reads the revision back; without them it refuses before any content write. Never follow it with generic update. Creating a separate page is your own explicit action, not a connector operation. Empty-string fields are stripped to prevent wipes.

**Development:** `pnpm vitest run --no-coverage`; see `AGENTS.md` for mappings and invariants.

**Troubleshooting:** check `/_mcp_tools` reachability and Nango connection for an unreachable `drupal_status`; renew the Bearer token for a `401`.

## Works with

- Drupal 10 and 11 with `drupal/mcp_tools`

## Capabilities

- Browse and read recent nodes
- Update unpublished nodes; save published-page edits as a same-node draft revision
- Publish by explicit request
- Edit nodes from plain-language instructions
- Edit the open node through an in-CMS chat widget
- Receive node-publication webhooks
