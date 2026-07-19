import { z } from "zod";
import type { ExtensionPrimitiveRequest } from "@cinatra-ai/sdk-extensions";

import { callDrupalMcp } from "../lib/drupal-mcp-client";
// Host-shared runtime surfaces (pagination + A2A dispatch + the instance-admin
// reads — `@/lib/drupal-api` stays host-side, cinatra#172 Stage H2) are
// resolved via DI so this package carries no non-SDK `@cinatra-ai/*` code
// dependency and no `@/` host-internal edge.
import { getDrupalDeps, listMcpInstancesSorted } from "../deps";
import type {
  DrupalMcpInstance,
  DrupalMcpPublicInstance,
  WidgetActorContext,
  WidgetActorOverride,
} from "../deps";

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
  // drupal_node_get's PRIMARY full-field read. mcp_jsonapi_list_entities
  // (drupal/mcp_tools `mcp_tools_jsonapi` submodule) runs an entity query over
  // MCP and returns each match through `serializeEntity`, which carries the
  // editable `body.value` source HTML the field-level diff needs. Filtered by
  // the numeric `nid` with `limit:1` it is a single-node read; it is
  // bundle-agnostic (the node entity query spans every bundle) so no per-bundle
  // enumeration is required. Proven live over the real endpoint against
  // drupal/mcp_tools 1.0.0-beta14 (zero /jsonapi/* egress; cinatra#1214 S2).
  READ: "mcp_jsonapi_list_entities",
  // drupal_node_get falls back to LIST (not READ) for transient MCP-read
  // unavailability. mcp_tools_search_content requires ≥3 chars and does not
  // support nid-specific lookup, so the recent-content scan is the fallback.
  // NOTE: this is a summary row WITHOUT `body` — a degraded fallback, never the
  // designed primary (cinatra#1214 S2 gate).
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

// S5 delegated-widget OBO reconstruction (cinatra S5-W1 §5 G3/G4). Build the
// carrier-run actor override from the TRUSTED widget actor context the host
// derives from the MCP request frame — NEVER from tool input. Fail-closed:
//   • a `public_site_widget` delegation MISSING pinned fields (blank runBy /
//     orgId / instanceId) is a malformed delegation → THROW (never fall through
//     to the normal identity path — the "missing override on a widget call"
//     negative case);
//   • G3 INSTANCE PIN — the model-supplied tool-arg `toolInstanceId` MUST equal
//     the actor's SERVER-PINNED `instanceId`, else `instance_pin_mismatch` (a
//     prompt-injected / confused-model attempt to target a different
//     origin-matched instance in the same org is refused, no write).
// The returned override drives `dispatchContentEditor`'s `actorOverride`, so the
// carrier run authorizes AS THE END USER against the pinned instance with the
// platform-admin-suppressing `sourceType`.
function buildWidgetActorOverride(
  actor: WidgetActorContext,
  toolInstanceId: string,
  primitiveName: string,
): WidgetActorOverride {
  if (!actor.runBy || !actor.orgId || !actor.instanceId) {
    throw new Error(
      `${primitiveName} denied: public_site_widget delegation is missing the pinned actor fields (runBy/orgId/instanceId).`,
    );
  }
  if (toolInstanceId !== actor.instanceId) {
    throw new Error(
      `instance_pin_mismatch: ${primitiveName} tool-arg instanceId "${toolInstanceId}" ` +
        "does not match the widget actor's server-pinned instance.",
    );
  }
  return {
    runBy: actor.runBy,
    orgId: actor.orgId,
    instanceId: actor.instanceId,
    sourceType: "public_site_widget",
  };
}

// ---------------------------------------------------------------------------
// MCP-primary full-field read (the field-level-diff fix; cinatra#1214 S2).
//
// The content-editor agent's STEP 1 must see the editable before-values
// (`title`, `body`, …) so STEP 4 can emit a real before/after diff.
// `mcp_tools_get_recent_content` only carries a summary row WITHOUT `body`, so
// the read routes a single-node query through the Drupal MCP module
// (`mcp_jsonapi_list_entities`, drupal/mcp_tools `mcp_tools_jsonapi` submodule)
// over the SAME `/_mcp_tools` transport + Nango bearer the write path uses — NO
// direct `/jsonapi/*` `fetch()` egress. The house rule (#1214 / epic #1037): an
// in-admin assistant reaches a CMS only through that CMS's MCP integration.
//
// Proven live over the real endpoint (drupal/mcp_tools 1.0.0-beta14): the tool
// returns each match through the module's `serializeEntity`, which surfaces the
// raw stored `body.value` (NOT the filter-expanded `processed` render output) as
// a top-level `fields.body` string — exactly the before-value the diff needs.
// ---------------------------------------------------------------------------

// The subset of drupal/mcp_tools `serializeEntity` output the read consumes. The
// module flattens each single-cardinality field to its `value` (or `target_id`),
// so a text_with_summary `body` arrives as `fields.body` = the raw source HTML.
type McpJsonApiEntity = {
  entity_type?: unknown;
  bundle?: unknown;
  id?: unknown;
  uuid?: unknown;
  label?: unknown;
  status?: unknown;
  fields?: Record<string, unknown>;
};

// Flatten a serialized MCP entity into the flat object the content-editor agent
// reads in STEP 1. Editable before-values are surfaced at the top level —
// notably `body` as the raw `body.value` source HTML the module already
// flattened into `fields.body`. `id` is the numeric nid string so it stays
// continuous with the write path (drupal_node_update keys on nodeId, not the
// uuid). NOTE: drupal/mcp_tools' `serializeEntity` collapses the compound body
// field to its `.value`, so the text-summary sub-value is not carried over MCP;
// `summary` defaults to "" (see the #1214 S2 note). The GATE before-value —
// `body.value` — IS preserved, so this is a full-body read, never a
// summary-only degradation.
function flattenMcpNode(entity: McpJsonApiEntity): Record<string, unknown> {
  const fields =
    entity.fields && typeof entity.fields === "object" ? entity.fields : {};
  const idNum = Number(entity.id);
  // Spread the module's flattened field map first, then overwrite the editable
  // before-values with normalized top-level forms so a compound field value can
  // never clobber the `title`/`body` strings the diff reads.
  return {
    ...fields,
    id: entity.id != null ? String(entity.id) : undefined,
    nid: Number.isFinite(idNum) ? idNum : undefined,
    uuid: entity.uuid,
    bundle: entity.bundle,
    title:
      typeof fields.title === "string"
        ? fields.title
        : typeof entity.label === "string"
          ? entity.label
          : "",
    body: typeof fields.body === "string" ? fields.body : "",
    summary: "",
    status: entity.status,
  };
}

// Full-field single-node read over the Drupal MCP module. Runs
// `mcp_jsonapi_list_entities` filtered by the numeric `nid` with `limit:1` — a
// node entity query that spans every bundle (no per-bundle enumeration) and
// returns the fully-serialized node incl. `fields.body`. Returns the flattened
// node, or null when the node is not found — the caller then falls back to the
// recent-content summary lookup. Throws (propagated to the caller's try/catch)
// when the MCP read itself is unavailable (submodule disabled / restricted /
// transient), so the fallback covers only genuine unavailability, never a
// successful "not found".
async function readNodeViaMcp(
  instance: DrupalMcpInstance,
  nid: number,
): Promise<Record<string, unknown> | null> {
  const raw = (await callDrupalMcp(instance, TOOL.READ, {
    entity_type: "node",
    filters: { nid },
    limit: 1,
  })) as unknown;
  // callDrupalMcp unwraps the { success, message, data } envelope, so `raw` is
  // the data object: { items: [serializedEntity], total, ... }.
  const data = raw as Record<string, unknown>;
  const items: unknown[] = Array.isArray(data?.items)
    ? (data.items as unknown[])
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];
  const hit = items.find((n): n is McpJsonApiEntity => {
    if (typeof n !== "object" || n === null) return false;
    const obj = n as McpJsonApiEntity;
    // Confirm the returned entity is the requested node (defensive: the filter
    // already scopes to this nid). `fields.nid` is the base-field backstop.
    const fieldNid = (obj.fields as { nid?: unknown } | undefined)?.nid;
    return Number(obj.id) === nid || Number(fieldNid) === nid;
  });
  return hit ? flattenMcpNode(hit) : null;
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

      // PRIMARY — full-field read over the Drupal MCP module (no direct
      // /jsonapi/* egress; cinatra#1214 S2). The agent's STEP 1 needs the
      // editable `body`/`title` before-values (which the recent-content summary
      // row lacks) so STEP 4 can emit a real before/after change set like the
      // WordPress agent.
      try {
        const node = await readNodeViaMcp(instance, nid);
        if (node) return node;
        // MCP read reachable but node absent — fall through to the summary
        // lookup, which also covers nodes the MCP read's access policy hides.
      } catch {
        // MCP jsonapi read unavailable (mcp_tools_jsonapi disabled / restricted
        // / transient). Fall back to the recent-content summary so the read
        // never hard-fails on a healthy site.
      }

      // FALLBACK — recent-content summary lookup (transient MCP-read
      // unavailability ONLY, never the designed primary; #1214 S2 gate). This is
      // still the Drupal MCP module (same /_mcp_tools transport), just a summary
      // tool WITHOUT `body`. mcp_tools_search_content requires ≥3 chars and does
      // full-text search, not nid lookup; single/two-digit node IDs always fail
      // it. Use mcp_tools_get_recent_content instead.
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
          `Node ${nid} not found via mcp_jsonapi_list_entities or in recent 100 nodes via mcp_tools_get_recent_content`,
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
      const deps = getDrupalDeps();

      // S5 delegated-widget OBO reconstruction (cinatra S5-W1). When the turn is
      // driven by a trusted `public_site_widget` delegated actor, the downstream
      // CMS write must authorize AS THE END USER against the SERVER-PINNED
      // instance. Read the actor context the host derives from the MCP request
      // frame (NEVER from tool input); `null` on the normal (non-widget) agent
      // path, where the dispatch stays byte-identical to today. On the widget
      // path `buildWidgetActorOverride` fail-closes on a missing pin field and
      // asserts the tool-arg instance pin (G3) before the override is built.
      const widgetActor = deps.resolveWidgetActor?.() ?? null;
      const actorOverride: WidgetActorOverride | undefined = widgetActor
        ? buildWidgetActorOverride(widgetActor, input.instanceId, "drupal_content_editor_run")
        : undefined;

      const a2aUrl =
        process.env.DRUPAL_CONTENT_EDITOR_A2A_URL ??
        "http://localhost:3010/agents/cinatra-ai/drupal-agent";

      const text = await deps.dispatchContentEditor({
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
        // S5: present ONLY on the public_site_widget path (undefined omits the
        // key entirely, so the non-widget dispatch is byte-identical to today).
        ...(actorOverride ? { actorOverride } : {}),
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
