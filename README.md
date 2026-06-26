# Drupal MCP

Let Cinatra agents read, draft, and publish content on your Drupal sites. Connect one or more Drupal instances and your agents can browse recent nodes, create draft revisions, update fields, and push updates live — including a natural-language path that turns a single instruction into the right sequence of edits.

**Install:** add the connector from the Cinatra marketplace. Your Drupal site must run `drupal/mcp_tools ^1.0` with its Streamable HTTP endpoint (`/_mcp_tools`) reachable from the Cinatra host. Create a Nango connection for the `cinatra-drupal` integration (provider: `private-api-bearer`), then open **Settings → Integrations → Drupal** to register each instance by site URL and Nango connection ID.

**Usage:** once registered, agents discover instances via `drupal_instances_list`. Ask an agent to list recent nodes, create a draft, update fields, or publish. For free-form edits, `drupal_content_editor_run` accepts a plain-language instruction and handles the full draft-revision workflow automatically.

**Configuration:** each instance requires a `siteUrl` and a `nangoConnectionId`. No plaintext credentials are stored — the Bearer token lives only in the Nango vault and is resolved at call time.

**API notes:** `drupal_node_get` proxies via the recent-content list (only the 100 most-recent nodes are reachable). `drupal_node_update` requires a draft revision — call `drupal_node_create_draft_revision` before updating a published node. Fields set to an empty string are stripped before dispatch to prevent accidental field wipes.

**Development:** run `pnpm vitest run --no-coverage` from the package directory. See `AGENTS.md` for primitive-to-tool-name mapping and key invariants.

**Troubleshooting:** if `drupal_status` reports an instance as unreachable, verify `/_mcp_tools` is accessible and the Nango connection is active. A `401` from Drupal means the Bearer token has expired — regenerate it in `drupal/mcp_tools` and update the Nango connection.

## Works with

- Drupal 10 and 11 with the `drupal/mcp_tools` module installed

## Capabilities

- Browse and read recent Drupal nodes from inside an agent flow
- Draft a new node of any configured content type
- Update fields on an existing node through a clean draft revision
- Publish a draft to make it live
- Edit a Drupal node from a plain-language instruction
