# Drupal MCP

Let Cinatra agents read, draft, and publish content on your Drupal sites. Connect one or more Drupal instances to browse nodes, update unpublished fields, and publish by explicit request. Published-page edits require protected same-node draft support; this version refuses those edits while an exact-revision MCP reader is unavailable.

**Install:** add the connector from the Cinatra marketplace. Your Drupal site must run `drupal/mcp_tools ^1.0` with its Streamable HTTP endpoint (`/_mcp_tools`) reachable from the Cinatra host. Create a Nango connection for the `cinatra-drupal` integration (provider: `private-api-bearer`), then open **Settings → Integrations → Drupal** to register each instance by site URL and Nango connection ID.

**Usage:** agents discover instances via `drupal_instances_list`; ask an agent to list recent nodes, create a draft, update fields, or publish. `drupal_content_editor_run` turns a plain-language instruction into the full draft-revision workflow.

**Configuration:** each instance needs a `siteUrl` and a `nangoConnectionId`; no plaintext credentials are stored — the Bearer token lives only in the Nango vault, resolved at call time.

**Architecture:** the connector owns the Drupal MCP client and instance-settings store and registers the drupal-mcp and widget-auth capabilities itself at activation — the Cinatra core ships no Drupal client code. In dev, its `cinatra.devSetup` hook provisions the local Drupal fixture on boot.

**API notes:** `drupal_node_get` reads full fields through MCP, with a recent-content summary fallback on unavailability. `drupal_node_update` reads actual status and refuses published or unknown-status nodes. `drupal_node_create_draft_revision` takes `instanceId`, `nodeId` and `fields` for a protected edit of the same node; it never creates a new page. It currently refuses before content writes because the backend lacks exact-revision MCP readback. Content Moderation and supported revision-reading tools are required; a separate new page needs your explicit choice. Never follow a draft request with generic update. Empty-string fields are stripped to prevent accidental wipes.

**Development:** run `pnpm vitest run --no-coverage`. See `AGENTS.md` for tool-name mapping and invariants.

**Troubleshooting:** if `drupal_status` reports an instance unreachable, verify `/_mcp_tools` is reachable and the Nango connection is active; a `401` means the Bearer token expired — regenerate it and update the Nango connection.

## Works with

- Drupal 10 and 11 with the `drupal/mcp_tools` module installed

## Capabilities

- Browse and read recent Drupal nodes from inside an agent flow
- Draft a new node of any configured content type
- Update unpublished nodes; refuse unsafe edits to published pages
- Publish a draft to make it live
- Edit a Drupal node from a plain-language instruction
- Chat with an in-CMS widget that edits the open node in the Drupal editor
- Receive a webhook notification when a node is published on a connected site
