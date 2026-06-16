import { z } from "zod";
import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";

import { callDrupalMcp } from "../lib/drupal-mcp-client";
// Host-shared runtime surfaces (pagination + A2A dispatch + the instance-admin
// reads — `@/lib/drupal-api` stays host-side, cinatra#172 Stage H2) are
// resolved via DI so this package carries no non-SDK `@cinatra-ai/*` code
// dependency and no `@/` host-internal edge.
import { getDrupalDeps, listMcpInstancesSorted } from "../deps";

// Strip Markdown code fences from LLM-emitted JSON before parse. The
// wayflow-drupal-content-editor agent's LLM occasionally wraps its JSON output
// in ```json ... ``` fences; the regex only matches at string boundaries so
// internal triplets survive.
function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\n?|\n?```$/g, "").trim();
}

// ---------------------------------------------------------------------------
// Drupal tool name constants.
// Drupal 11 + drupal/mcp_tools ^1.0@beta on the development instance.
// ---------------------------------------------------------------------------
const TOOL = {
  UPDATE: "mcp_update_content",
  // mcp_create_content with status:false creates a draft revision
  CREATE_DRAFT: "mcp_create_content",
  // drupal_node_get uses LIST (not READ) because mcp_tools_search_content requires ≥3 chars
  // and does not support nid-specific lookup.
  LIST: "mcp_tools_get_recent_content",
  PUBLISH: "mcp_publish_content",
} as const;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const instanceIdSchema = z.object({
  instanceId: z.string().min(1),
});

export const nodeGetSchema = z.object({
  instanceId: z.string().min(1),
  nodeId: z.string().min(1),
});

export const nodeUpdateSchema = z.object({
  instanceId: z.string().min(1),
  nodeId: z.string().min(1),
  fields: z.record(z.string(), z.unknown()),
});

export const nodeCreateDraftSchema = z.object({
  instanceId: z.string().min(1),
  nodeBundle: z.string().min(1),
  title: z.string().min(1),
  fields: z.record(z.string(), z.unknown()).optional(),
});

export const nodeListSchema = z.object({
  instanceId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  contentType: z.string().optional(),
});

// A2A blocking dispatch to wayflow-drupal-content-editor.
export const drupalContentEditorRunSchema = z.object({
  instanceId:   z.string().min(1).describe("Drupal instance ID from connector administration"),
  nodeId:       z.string().min(1).describe("Drupal node ID to edit"),
  nodeBundle:   z.string().optional().default("").describe("Node bundle / content type"),
  nodeStatus:   z.string().optional().default("").describe("Current publish status: published or draft"),
  instructions: z.string().min(1).describe("Natural language editing instructions"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveInstance(instanceId: string) {
  const instances = listMcpInstancesSorted();
  const instance = instances.find((i) => i.id === instanceId);
  if (!instance) throw new Error("Drupal instance not found.");
  return instance;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createDrupalPrimitiveHandlers() {
  return {
    drupal_status: async (_request: ExtensionPrimitiveRequest<unknown>) => {
      return getDrupalDeps().getApiStatus();
    },

    drupal_instances_list: async (_request: ExtensionPrimitiveRequest<unknown>) => {
      const instances = listMcpInstancesSorted();
      // Credentials live only in the Nango vault and are resolved at call time
      // via callDrupalMcp / the external-MCP toolbox. The instance row exposes
      // name/siteUrl + nangoConnectionId/providerConfigKey, with no secret
      // material, so no further stripping is needed.
      return instances;
    },

    drupal_node_get: async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = nodeGetSchema.parse(request.input);
      const instance = await resolveInstance(input.instanceId);
      const nid = parseInt(input.nodeId, 10);
      if (!Number.isFinite(nid) || nid <= 0) {
        throw new Error(`Invalid nodeId: "${input.nodeId}" is not a positive integer`);
      }
      // mcp_tools_search_content requires ≥3 chars and does full-text search,
      // not nid lookup; single/two-digit node IDs always fail it. Use
      // mcp_tools_get_recent_content instead.
      // callDrupalMcp unwraps the { success, message, data } envelope — listRaw is the data
      // object: { total, sorted_by, content: [{ id, ... }] }. `id` is from $node->id().
      const listRaw = await callDrupalMcp(instance, TOOL.LIST, { limit: 100 }) as unknown;
      const raw = listRaw as Record<string, unknown>;
      const items: unknown[] = Array.isArray(listRaw)
        ? listRaw
        : Array.isArray(raw?.content)
          ? (raw.content as unknown[])
          : [];
      const node = items.find((n): n is Record<string, unknown> => {
        if (typeof n !== "object" || n === null) return false;
        const obj = n as Record<string, unknown>;
        return Number(obj.id) === nid || Number((obj as { nid?: unknown }).nid) === nid;
      });
      if (!node) {
        throw new Error(
          `Node ${nid} not found in recent 100 nodes via mcp_tools_get_recent_content`,
        );
      }
      return node;
    },

    drupal_node_update: async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = nodeUpdateSchema.parse(request.input);
      const instance = await resolveInstance(input.instanceId);
      // mcp_update_content — pass nid as string to avoid PHP strtolower() type error
      // in drupal/mcp_tools ^1.0 which calls strtolower() on the nid field expecting a string.
      const nid = parseInt(input.nodeId, 10);
      if (!Number.isFinite(nid) || nid <= 0) {
        throw new Error(`Invalid nodeId: "${input.nodeId}" is not a positive integer`);
      }
      // Distinguish "no fields supplied" from "all fields stripped".
      // `z.record` allows {}, so the schema cannot reject the empty-object
      // case; surface a precise error instead of claiming everything was an
      // empty string.
      if (Object.keys(input.fields).length === 0) {
        throw new Error("No fields provided.");
      }
      // Strip empty-string fields. The LLM occasionally emits `{ body: "" }`
      // for a title-only edit; Drupal applies it literally and wipes the body.
      // Filter here, not in callDrupalMcp, which serves multiple primitives
      // and not all of them want this behavior.
      // Only literal "" is dropped — null/undefined/false/0 pass through
      // unchanged so legitimate clears (e.g. boolean field flags) still work.
      const safeFields = Object.fromEntries(
        Object.entries(input.fields).filter(([, v]) => v !== ""),
      );
      // Guard against dispatching an update after all submitted fields were filtered.
      // null/undefined are intentionally NOT filtered — they are legitimate field clears
      // for Drupal; only the empty-string case is the LLM hallucination threat.
      if (Object.keys(safeFields).length === 0) {
        throw new Error("All submitted fields were empty strings — nothing to update.");
      }
      return callDrupalMcp(instance, TOOL.UPDATE, {
        nid: String(nid),
        updates: safeFields,
      });
    },

    drupal_node_create_draft_revision: async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = nodeCreateDraftSchema.parse(request.input);
      const instance = await resolveInstance(input.instanceId);
      // Strip empty-string fields. Same threat class as drupal_node_update:
      // an LLM emitting `{ body: "" }` would otherwise create a draft with an
      // empty body. Strict equality on "" only; null/false/0 pass through.
      const safeFields = input.fields
        ? Object.fromEntries(
            Object.entries(input.fields).filter(([, v]) => v !== ""),
          )
        : undefined;
      // mcp_create_content with status:false creates a draft (not published)
      return callDrupalMcp(instance, TOOL.CREATE_DRAFT, {
        type: input.nodeBundle,
        title: input.title,
        ...(safeFields && Object.keys(safeFields).length > 0
          ? { fields: safeFields }
          : {}),
        status: false,
      });
    },

    drupal_node_list: async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = nodeListSchema.parse(request.input);
      const instance = await resolveInstance(input.instanceId);
      const offset = getDrupalDeps().decodeCursor(input.cursor);
      const limit = input.limit ?? 20;
      const args: Record<string, unknown> = { limit, offset };
      if (input.contentType) args.content_type = input.contentType;
      const listRaw = await callDrupalMcp(instance, TOOL.LIST, args) as unknown;
      // mcp_tools_get_recent_content returns { total, sorted_by, content: [...] }
      // Same shape as drupal_node_get uses — extract content array the same way.
      const rawObj = listRaw as Record<string, unknown>;
      const dataBlock = rawObj?.data as Record<string, unknown> | undefined;
      const arr: unknown[] = Array.isArray(listRaw)
        ? listRaw
        : Array.isArray(rawObj?.content)
          ? (rawObj.content as unknown[])
          : Array.isArray(dataBlock?.content)
            ? (dataBlock.content as unknown[])
            : [];
      // Use a sentinel total so nextCursor is emitted when the page is full
      const total = offset + arr.length + (arr.length === limit ? 1 : 0);
      return getDrupalDeps().buildListPage(arr, total, offset, limit);
    },

    drupal_node_publish: async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = nodeGetSchema.parse(request.input);
      const instance = await resolveInstance(input.instanceId);
      // mcp_publish_content — pass nid as string (same strtolower() fix as drupal_node_update)
      const nid = parseInt(input.nodeId, 10);
      if (!Number.isFinite(nid) || nid <= 0) {
        throw new Error(`Invalid nodeId: "${input.nodeId}" is not a positive integer`);
      }
      return callDrupalMcp(instance, TOOL.PUBLISH, {
        nid: String(nid),
        publish: true,
      });
    },

    // A2A blocking dispatch to wayflow-drupal-content-editor.
    //
    // The transport-level concerns — minting the A2A bearer
    // (buildA2aBearerToken("openai")), opening the external A2A client, sending
    // the task, and walking task.history (NOT task.artifacts — WayFlow
    // A2AAgentWorker does not implement artifact reads) — live HOST-side behind
    // `deps.dispatchContentEditor`, which resolves with the agent's reply TEXT.
    // The connector keeps only the stripCodeFences + JSON.parse of that text, so
    // the @cinatra-ai/a2a + @cinatra-ai/llm runtime edges stay out of this
    // package. timeoutMs: 300_000 aligns with the Cinatra /chat blocking budget.
    drupal_content_editor_run: async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = drupalContentEditorRunSchema.parse(request.input);

      const a2aUrl =
        process.env.DRUPAL_CONTENT_EDITOR_A2A_URL ?? "http://localhost:3020";

      const text = await getDrupalDeps().dispatchContentEditor({
        agentUrl: a2aUrl,
        payload: JSON.stringify(input),
        timeoutMs: 300_000, // aligned with /chat blocking budget
        // cinatra#246: lets the host resolve the agent template + pre-create the
        // OBO agent_run so the CMS write authorizes via the production agent-run
        // OBO path (not the dev-admin bypass).
        packageName: "@cinatra-ai/drupal-agent",
      });

      // Strip code fences before JSON.parse.
      try {
        return JSON.parse(stripCodeFences(text));
      } catch {
        return { result: text };
      }
    },
  } as const;
}
