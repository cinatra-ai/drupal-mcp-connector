import { z } from "zod";
import type { ExtensionMcpToolServer, ExtensionMcpToolResult } from "@cinatra-ai/sdk-extensions";

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
