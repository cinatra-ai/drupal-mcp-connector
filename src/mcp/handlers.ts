import { z } from "zod";
import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";

import { callDrupalMcp } from "../lib/drupal-mcp-client";
// Host-shared runtime surfaces (pagination + A2A dispatch + the instance-admin
// reads — `@/lib/drupal-api` stays host-side, cinatra#172 Stage H2) are
// resolved via DI so this package carries no non-SDK `@cinatra-ai/*` code
// dependency and no `@/` host-internal edge.
import { getDrupalDeps, listMcpInstancesSorted } from "../deps";
import type { DrupalMcpInstance, DrupalMcpPublicInstance } from "../deps";

// READ-BOUNDARY redaction. A read/list primitive must NEVER emit the Nango
// credential binding. This projection drops `nangoConnectionId` +
// `providerConfigKey` (the vault slot a caller could use to reach the site's
// stored credential) and returns only non-secret display fields. Mirrors the
// WordPress sibling's `toPublicInstance`. Write/dispatch primitives are
// unaffected — they re-resolve the FULL row via `listMcpInstancesSorted()` and
// thread it host-side, where the binding is used to fetch the credential;
// callers never receive it.
function toPublicInstance(i: DrupalMcpInstance): DrupalMcpPublicInstance {
  return {
    id: i.id,
    name: i.name,
    siteUrl: i.siteUrl,
    lastValidatedAt: i.lastValidatedAt,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

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
  // drupal_node_get falls back to LIST (not READ) when JSON:API is unavailable
  // because mcp_tools_search_content requires ≥3 chars and does not support
  // nid-specific lookup.
  LIST: "mcp_tools_get_recent_content",
  PUBLISH: "mcp_publish_content",
} as const;

// JSON:API constants. The Drupal core JSON:API module (enabled by default on
// Drupal 11 and required by the connector's install profile) exposes the full
// field set of a node — crucially the editable `body.value` source HTML — which
// the `mcp_tools_get_recent_content` summary row does NOT carry. The
// content-editor agent's STEP 1 read must surface these before-values so its
// STEP 4 field-level diff (`changes: [{ field, before, after }]`) is populated
// the same way the WordPress agent's `wordpress_post_get` full read does.
const JSONAPI = {
  ACCEPT: "application/vnd.api+json",
  // Per-bundle node collection. JSON:API has no bundle-agnostic /jsonapi/node
  // (404), so the handler enumerates bundles and filters each by the numeric
  // nid (globally unique across bundles in Drupal).
  BUNDLES_PATH: "/jsonapi/node_type/node_type",
  NODE_COLLECTION: (bundle: string) => `/jsonapi/node/${bundle}`,
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
// Per-user / per-connector-instance write authorization (cinatra#409).
//
// EVERY write primitive calls this AFTER resolving the instance and BEFORE
// dispatching the write to callDrupalMcp. The host dep derives the trusted user
// actor from the active MCP request frame (NEVER from connector tool input),
// denies a null actor (no userId+orgId), and enforces the user's per-instance
// `use` entitlement via requireConnectorAuthority — throwing on deny.
//
// FAIL-CLOSED: the registry passes only an SDK-shape `actor` literal that is NO
// LONGER an authz input (the SDK types `request.actor` as `unknown`). If the
// host is old / skewed and the dep is unbound (or not a function), this guard
// THROWS rather than letting the write proceed under a synthetic/anonymous
// actor — the write path is deny-by-default when authorization cannot run.
async function requireWriteAuthority(instanceId: string, primitiveName: string): Promise<void> {
  const deps = getDrupalDeps();
  const gate = deps.requireInstanceWriteAuthority;
  if (typeof gate !== "function") {
    // Unbound on an old/partial host: deny — never write without the gate.
    throw new Error(
      `Drupal write "${primitiveName}" denied: per-user write-authority gate is unavailable ` +
        "(host requireInstanceWriteAuthority unbound). Refusing to write without authorization.",
    );
  }
  // Throws on deny (non-member / member-without-right / null actor / cross-org
  // instance / platform-admin on the widget path). Resolving == authorized.
  await gate({ instanceId, primitiveName });
}

// ---------------------------------------------------------------------------
// JSON:API full-field read (the field-level-diff fix).
//
// The content-editor agent's STEP 1 must see the editable before-values
// (`title`, `body`, `summary`, …) so STEP 4 can emit a real before/after diff.
// `mcp_tools_get_recent_content` only carries a summary row without `body`, so
// the read is upgraded to a JSON:API full-field fetch. The Nango-vault bearer is
// resolved via the host DI seam (same as the MCP client); JSON:API is read with
// `Authorization` when available and best-effort anonymously otherwise (core
// JSON:API permits anonymous reads of published content on the dev profile).
// ---------------------------------------------------------------------------

type JsonApiResource = {
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
};

async function jsonApiGet(
  instance: { id: string; siteUrl: string; nangoConnectionId: string; providerConfigKey: string },
  pathWithQuery: string,
): Promise<unknown> {
  const base = instance.siteUrl.replace(/\/+$/, "");
  const url = base + pathWithQuery;
  // Best-effort bearer — JSON:API may permit anonymous reads, so a missing
  // credential is NOT fatal here (unlike the MCP write path).
  let authHeader: { Authorization: string } | null = null;
  try {
    authHeader = await getDrupalDeps().buildNangoBearerHeader({
      providerConfigKey: instance.providerConfigKey,
      connectionId: instance.nangoConnectionId,
      label: `drupal-jsonapi-${instance.id}`,
    });
  } catch {
    authHeader = null;
  }
  const headers: Record<string, string> = { Accept: JSONAPI.ACCEPT };
  if (authHeader) headers.Authorization = authHeader.Authorization;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Drupal JSON:API ${pathWithQuery} → HTTP ${res.status}`);
  }
  return res.json();
}

// Flatten a JSON:API node resource into the flat object the content-editor
// agent reads in STEP 1. Editable before-values are surfaced at the top level
// — notably `body` as the raw `body.value` source HTML (NOT `body.processed`,
// which is filter-expanded render output and the wrong before-value for a write
// diff). `id` is the numeric nid string so it stays continuous with the write
// path (drupal_node_update keys on nodeId, not the JSON:API uuid).
function flattenJsonApiNode(resource: JsonApiResource): Record<string, unknown> {
  const attrs = resource.attributes ?? {};
  const nid = attrs.drupal_internal__nid;
  const bodyField = attrs.body as
    | { value?: unknown; summary?: unknown; format?: unknown }
    | undefined;
  // Spread scalar attributes first, then overwrite `body`/`summary` with the
  // flattened string forms so the compound `attributes.body` object can never
  // clobber the top-level editable `body` string (codex must-fix).
  return {
    ...attrs,
    id: nid != null ? String(nid) : resource.id,
    nid: nid != null ? Number(nid) : undefined,
    uuid: resource.id,
    bundle: typeof resource.type === "string" ? resource.type.replace(/^node--/, "") : undefined,
    title: attrs.title,
    body: typeof bodyField?.value === "string" ? bodyField.value : "",
    summary: typeof bodyField?.summary === "string" ? bodyField.summary : "",
    status: attrs.status,
  };
}

// Full-field JSON:API read of a node by numeric nid. Enumerates node bundles
// (cheap, cached endpoint) and queries each bundle's collection filtered by
// `drupal_internal__nid` (globally unique across bundles) until a hit. Returns
// the flattened node, or null when JSON:API is unavailable / the node is not
// found — the caller then falls back to the recent-content summary lookup.
async function readNodeViaJsonApi(
  instance: { id: string; siteUrl: string; nangoConnectionId: string; providerConfigKey: string },
  nid: number,
): Promise<Record<string, unknown> | null> {
  // Enumerate node bundle machine names.
  const bundlesDoc = (await jsonApiGet(
    instance,
    `${JSONAPI.BUNDLES_PATH}?fields%5Bnode_type--node_type%5D=drupal_internal__type`,
  )) as { data?: Array<{ attributes?: { drupal_internal__type?: unknown } }> };
  const bundles = Array.isArray(bundlesDoc?.data)
    ? bundlesDoc.data
        .map((b) => b.attributes?.drupal_internal__type)
        .filter((t): t is string => typeof t === "string")
    : [];
  if (bundles.length === 0) return null;

  for (const bundle of bundles) {
    // filter[drupal_internal__nid]={nid}&page[limit]=1 — bracket chars are
    // percent-encoded so the query string is well-formed.
    const query =
      `?filter%5Bdrupal_internal__nid%5D=${encodeURIComponent(String(nid))}` +
      `&page%5Blimit%5D=1`;
    let doc: { data?: JsonApiResource[] };
    try {
      doc = (await jsonApiGet(
        instance,
        JSONAPI.NODE_COLLECTION(bundle) + query,
      )) as { data?: JsonApiResource[] };
    } catch {
      // A single bundle 403/404 is non-fatal — try the next bundle.
      continue;
    }
    const hit = Array.isArray(doc?.data) ? doc.data[0] : undefined;
    if (hit) return flattenJsonApiNode(hit);
  }
  return null;
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
      // Redact the Nango credential binding at the read boundary: the LLM tool
      // caller receives only id/name/siteUrl/timestamps, never
      // nangoConnectionId/providerConfigKey (see toPublicInstance).
      return listMcpInstancesSorted().map(toPublicInstance);
    },

    drupal_node_get: async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = nodeGetSchema.parse(request.input);
      const instance = await resolveInstance(input.instanceId);
      const nid = parseInt(input.nodeId, 10);
      // Validation must throw BEFORE any read so a bad nodeId never silently
      // falls back to a summary lookup (codex must-fix).
      if (!Number.isFinite(nid) || nid <= 0) {
        throw new Error(`Invalid nodeId: "${input.nodeId}" is not a positive integer`);
      }

      // PRIMARY — full-field JSON:API read. This is the field-level-diff fix:
      // the agent's STEP 1 needs the editable `body`/`title`/`summary`
      // before-values (which the recent-content summary row lacks) so STEP 4
      // can emit a real before/after change set like the WordPress agent.
      try {
        const node = await readNodeViaJsonApi(instance, nid);
        if (node) return node;
        // JSON:API reachable but node absent — fall through to the summary
        // lookup, which also covers nodes the JSON:API access policy hides.
      } catch {
        // JSON:API unavailable (module disabled / restricted / transient).
        // Fall back to the recent-content summary so the read never regresses.
      }

      // FALLBACK — recent-content summary lookup (the pre-fix behavior).
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
          `Node ${nid} not found via JSON:API or in recent 100 nodes via mcp_tools_get_recent_content`,
        );
      }
      return node;
    },

    drupal_node_update: async (request: ExtensionPrimitiveRequest<unknown>) => {
      const input = nodeUpdateSchema.parse(request.input);
      const instance = await resolveInstance(input.instanceId);
      // cinatra#409 — per-user / per-instance write authorization (fail-closed).
      // Throws on deny BEFORE any write reaches the Drupal site.
      await requireWriteAuthority(input.instanceId, "drupal_node_update");
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
      // cinatra#409 — per-user / per-instance write authorization (fail-closed).
      await requireWriteAuthority(input.instanceId, "drupal_node_create_draft_revision");
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
      // cinatra#409 — per-user / per-instance write authorization (fail-closed).
      await requireWriteAuthority(input.instanceId, "drupal_node_publish");
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
        process.env.DRUPAL_CONTENT_EDITOR_A2A_URL ??
        "http://localhost:3010/agents/cinatra-ai/drupal-agent";

      const text = await getDrupalDeps().dispatchContentEditor({
        agentUrl: a2aUrl,
        // #72 payload-contract parity: pass the validated `input` OBJECT (the
        // host serializes it as the A2A message text), matching the WordPress
        // connector's shape so ONE shared host helper serves both.
        payload: input,
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
