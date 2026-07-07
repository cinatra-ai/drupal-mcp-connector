# Drupal MCP

Let Cinatra agents read, draft, and publish content on your Drupal sites. Connect one or more Drupal instances and your agents can browse recent nodes, create draft revisions, update fields, and push updates live.

**Install:** add the connector from the Cinatra marketplace. Your Drupal site must run `drupal/mcp_tools ^1.0` with its Streamable HTTP endpoint (`/_mcp_tools`) reachable from the Cinatra host. Create a Nango connection for the `cinatra-drupal` integration (provider: `private-api-bearer`), then open **Settings → Integrations → Drupal** to register each instance by site URL and Nango connection ID.

**Usage:** agents discover instances via `drupal_instances_list`; ask an agent to list recent nodes, create a draft, update fields, or publish. `drupal_content_editor_run` turns a plain-language instruction into the full draft-revision workflow.

**Configuration:** each instance needs a `siteUrl` and a `nangoConnectionId`; no plaintext credentials are stored — the Bearer token lives only in the Nango vault, resolved at call time.

**Architecture:** the connector owns the Drupal MCP client and instance-settings store and registers the drupal-mcp and widget-auth capabilities itself at activation — the Cinatra core ships no Drupal client code. In dev, its `cinatra.devSetup` hook provisions the local Drupal fixture on boot.

**API notes:** `drupal_node_get` proxies via the recent-content list (100 most-recent nodes). `drupal_node_update` needs a draft revision — call `drupal_node_create_draft_revision` first. Empty-string fields are stripped to prevent accidental wipes.

**Development:** run `pnpm vitest run --no-coverage`. See `AGENTS.md` for tool-name mapping and invariants.

**Troubleshooting:** if `drupal_status` reports an instance unreachable, verify `/_mcp_tools` is reachable and the Nango connection is active; a `401` means the Bearer token expired — regenerate it and update the Nango connection.

## Works with

- Drupal 10 and 11 with the `drupal/mcp_tools` module installed

## Capabilities

- Browse and read recent Drupal nodes from inside an agent flow
- Draft a new node of any configured content type
- Update fields on an existing node through a clean draft revision
- Publish a draft to make it live
- Edit a Drupal node from a plain-language instruction
- Chat with an in-CMS widget that edits the open node in the Drupal editor
- Receive a webhook notification when a node is published on a connected site
