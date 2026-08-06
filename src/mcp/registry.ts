import { z } from "zod";
import type { ExtensionMcpToolServer, ExtensionMcpToolResult } from "@cinatra-ai/sdk-extensions";

// ---------------------------------------------------------------------------
// WHY `zod` IS DECLARED, AND WHY AT THIS EXACT RANGE (#83).
//
// `zod` used to be imported here (and in `./handlers`, and in
// `../webhooks/node-published`) without being declared anywhere — the same
// phantom-dependency class `@modelcontextprotocol/client` was in before
// cinatra#2218 L2e: resolved purely through the consuming host's hoisted root
// `node_modules` symlink, which pnpm's isolated linker publishes only for a
// direct dependency of the ROOT importer. It is now declared in this package's
// own `dependencies`, at `^4.4.3` — the cinatra host's OWN range, character for
// character. Neither half of that is cosmetic.
//
// TWO REAL FLOORS, so not a wider range. The schemas below LEAVE this package:
// `registerTool` hands them across the host boundary and the host publishes
// their argument shape on `tools/list`. Both bounds below are measured, against
// a real `@modelcontextprotocol/server` 2.0.0 and a real `tsc`, across zod
// 3.25.76 / 4.0.0 / 4.1.12 / 4.2.0 / 4.4.3 — not inferred from release notes:
//
//   RUNTIME floor is major 4. A zod 3.x schema does NOT fail locally and does
//   NOT merely lose its own argument shape: it registers CLEANLY — so no
//   try/catch at the call site can see it — and then fails the ENTIRE
//   `tools/list` with JSON-RPC -32603, "Schema appears to be from zod 3, which
//   the SDK cannot convert to JSON Schema." One unconvertible schema takes down
//   every Drupal tool at once, the first time a client lists them. Every 4.x
//   tested converts fine, including 4.0 and 4.1 — the SDK has a zod-4 path that
//   does not go through Standard Schema at all.
//
//   TYPE floor is 4.2. The host's `ExtensionStandardSchema` requires
//   `~standard.jsonSchema`, which zod first exposes in 4.2.0. On 4.0/4.1 the
//   `registerTool` call below stops compiling (TS2322, `ZodType` not assignable
//   to `ExtensionStandardSchema`) even though it would have run.
//
// So 3.x is a reachable outage rather than an old-but-workable option — and the
// host tree really does carry a 3.x copy alongside the 4.x one, pulled
// transitively by an unrelated dependency. `^4.4.3` clears both floors with
// room; anything looser has to clear both deliberately.
//
// TRACKING THE HOST, so not an exact pin — a convention, NOT a correctness
// cliff, and worth being accurate about. The host reads these schemas
// structurally through `~standard`, never through `instanceof`, so a second
// compatible zod 4.x instance in the tree would still work; this is not a
// single-realm requirement, and pnpm would not guarantee one anyway (a filtered
// update can move the root importer alone, leaving matching ranges resolved
// apart). What carrying the host's range verbatim actually buys is that a full
// resolution typically converges the connector and the host on ONE instance
// rather than installing a second copy — measured on this change: both resolve
// to the same store path — and that a host bump inside major 4 carries this
// package along instead of stranding it a version behind. It is also what all fifteen
// sibling extensions declaring `zod` do. `@modelcontextprotocol/client` one
// directory over IS exact-pinned, and that is not an inconsistency: it is
// connector-private, nothing built from it crosses back to the host, and no
// other importer has an opinion about its version.
//
// The residual coordination point, stated rather than left implicit: a host move
// to a zod MAJOR past 4 has to reconcile this line. That is now VISIBLE — the
// edge appears in the host's lockfile — where the undeclared import made the
// same coupling invisible.
// ---------------------------------------------------------------------------

import {
  createDrupalPrimitiveHandlers,
  nodeGetSchema,
  nodeListSchema,
  nodeUpdateSchema,
  nodeCreateDraftSchema,
  drupalContentEditorRunSchema,
} from "./handlers";

// ---------------------------------------------------------------------------
// Tool metadata — descriptions surfaced to LLMs via /api/mcp
// ---------------------------------------------------------------------------

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  drupal_status: {
    description:
      "Get the Drupal connector status: list of configured instances + last validation timestamp.",
    inputSchema: z.object({}),
  },
  drupal_instances_list: {
    description:
      "List configured Drupal instances (without exposing the MCP Bearer key).",
    inputSchema: z.object({}),
  },
  drupal_node_get: {
    description:
      "Read a Drupal node by id. Iterates the 100 most-recent nodes via mcp_tools_get_recent_content and matches on node id (drupal/mcp_tools has no direct get-by-id primitive). Returns the matching node object or throws if the node is not in the recent 100.",
    inputSchema: nodeGetSchema,
  },
  drupal_node_update: {
    description:
      "Update a Drupal node fields. The nodeId is converted to a numeric nid. Caller must call drupal_node_create_draft_revision first if the node is published.",
    inputSchema: nodeUpdateSchema,
  },
  drupal_node_create_draft_revision: {
    description:
      "Create a new draft content node of a given bundle (type). Uses mcp_create_content with status:false. Call BEFORE drupal_node_update when the node is published.",
    inputSchema: nodeCreateDraftSchema,
  },
  drupal_node_list: {
    description:
      "List recent Drupal nodes with optional cursor-based pagination. Uses mcp_tools_get_recent_content.",
    inputSchema: nodeListSchema,
  },
  drupal_node_publish: {
    description:
      "Publish a draft Drupal node. Converts nodeId string to integer nid and calls mcp_publish_content with publish:true.",
    inputSchema: nodeGetSchema,
  },
  drupal_content_editor_run: {
    description:
      "Edit a Drupal node using natural language instructions. Dispatches to the drupal-content-editor WayFlow agent which handles the draft-revision workflow automatically. Returns { nodeId, changes: [{ field, before, after }] } or { result: <text> } if the agent's reply isn't JSON. Requires the wayflow-drupal-content-editor container to be running (docker compose --profile drupal up).",
    inputSchema: drupalContentEditorRunSchema,
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDrupalPrimitives(server: ExtensionMcpToolServer): void {
  const handlers = createDrupalPrimitiveHandlers();

  for (const [name, handler] of Object.entries(handlers)) {
    // cinatra#246: NEVER expose the content-editor RELAY as an MCP tool. It is
    // a dispatch primitive (it sends an A2A task to the drupal-content-editor
    // agent), not a CMS read/write capability. When the leaf agent has the
    // cinatra MCP server injected it would otherwise see `drupal_content_editor_run`
    // in tools/list and call it — re-dispatching itself (observed: recursive
    // mcp_call -> 504). The host relays to the agent directly via
    // dispatchContentEditorViaA2A; this name must not be a model-visible tool.
    if (name === "drupal_content_editor_run") continue;
    const meta =
      TOOL_META[name] ?? {
        description: name,
        inputSchema: z.object({}).passthrough(),
      };
    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
      },
      async (input): Promise<ExtensionMcpToolResult> => {
        const result = await handler({
          primitiveName: name,
          input,
          // cinatra#409: this synthetic literal is NO LONGER an authorization
          // input. Write authz is enforced inside the handler via the host dep
          // `requireInstanceWriteAuthority`, which derives the trusted user
          // actor host-side from the active MCP request frame
          // (mcpRequestContextStorage) — NEVER from this field or from tool
          // input. `request.actor` is typed `unknown` by the SDK and is kept
          // here only to satisfy the ExtensionPrimitiveRequest shape; nothing
          // in the handlers reads it for an authorization decision.
          actor: { actorType: "model", source: "agent" },
          mode: "agentic",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: Array.isArray(result)
            ? { items: result }
            : typeof result === "object" && result !== null
              ? (result as Record<string, unknown>)
              : { result },
        };
      },
    );
  }
}
