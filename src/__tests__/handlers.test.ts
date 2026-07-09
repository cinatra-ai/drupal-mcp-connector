import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// `@/lib/drupal-api` is GONE from the handlers graph (cinatra#172 Stage H2):
// the instance reads resolve via the deps slot, so this suite stubs the slot
// (registerDrupalConnector) instead of mocking a host module.
vi.mock("../lib/drupal-mcp-client", () => ({
  callDrupalMcp: vi.fn(),
}));

import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "@cinatra-ai/drupal-mcp-connector/mcp-handlers";

// Deps-slot member mocks for the host-bound instance-admin surface.
const listMcpInstancesMock = vi.fn((): any[] => []);
const getApiStatusMock = vi.fn(async () => ({ instanceCount: 0, instances: [] as any[] }));
// cinatra#409 — per-user write-authority gate mock. Default = ALLOW (resolves)
// so the pre-existing write happy-path tests keep their original behavior; the
// dedicated authz suite (write-authority.test.ts) overrides it to DENY (throw).
const requireInstanceWriteAuthorityMock = vi.fn(async (_input: { instanceId: string; primitiveName: string }) => {});

function registerHandlersDepsStub() {
  registerDrupalConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: vi.fn(async () => ""),
    buildNangoBearerHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
    listMcpInstances: listMcpInstancesMock,
    probeMcp: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl.replace(/\/+$/, "") + "/_mcp_tools",
    isPrivateUrl: () => false,
    isNangoConfigured: () => true,
    getApiStatus: getApiStatusMock,
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: vi.fn(async () => []),
    requireInstanceWriteAuthority: requireInstanceWriteAuthorityMock,
  });
}

// Actual tool names discovered against Drupal 11 + drupal/mcp_tools 1.0.0-beta14:
// drupal_node_get's PRIMARY full-field read routes through the MCP module's
// mcp_jsonapi_list_entities (mcp_tools_jsonapi submodule; carries body.value),
// and falls back to mcp_tools_get_recent_content (a summary row WITHOUT body)
// only when the MCP jsonapi read is unavailable (cinatra#1214 S2).
const DRUPAL_NODE_GET_READ_TOOL = "mcp_jsonapi_list_entities";
const DRUPAL_NODE_GET_FALLBACK_TOOL = "mcp_tools_get_recent_content";
const DRUPAL_NODE_UPDATE_TOOL = "mcp_update_content";
const DRUPAL_NODE_CREATE_DRAFT_TOOL = "mcp_create_content";   // status: false for draft
const DRUPAL_NODE_LIST_TOOL = "mcp_tools_get_recent_content";
const DRUPAL_NODE_PUBLISH_TOOL = "mcp_publish_content";

// Fixture mirrors the DrupalInstanceSettings shape: no mcpApiKey field
// (credentials live in Nango only), instead nangoConnectionId
// (== instance.id by convention) and providerConfigKey.
const inst = (over: Partial<{ id: string; name: string; siteUrl: string; nangoConnectionId: string; providerConfigKey: string }> = {}) => ({
  id: over.id ?? "site-1",
  name: over.name ?? "Site 1",
  siteUrl: over.siteUrl ?? "http://localhost:8082",
  nangoConnectionId: over.nangoConnectionId ?? over.id ?? "site-1",
  providerConfigKey: over.providerConfigKey ?? "cinatra-drupal",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

// `drupal_node_get` reads the full node over MCP via `callDrupalMcp`
// (mcp_jsonapi_list_entities), with mcp_tools_get_recent_content as the
// transient-unavailability fallback (cinatra#1214 S2). Both are the SAME mocked
// `callDrupalMcp`; tests drive them by switching on the tool-name argument.
//
// `serializedNode` mirrors the drupal/mcp_tools `serializeEntity` shape the read
// consumes: top-level entity_type/bundle/id/uuid/label/status + a `fields` map
// whose single-cardinality members are already flattened (a text_with_summary
// `body` arrives as `fields.body` = the raw body.value string).
function serializedNode(over: Record<string, unknown> = {}) {
  const { fields, ...rest } = over as { fields?: Record<string, unknown> };
  return {
    entity_type: "node",
    bundle: "article",
    id: 5,
    uuid: "uuid-123",
    label: "Old headline",
    status: true,
    ...rest,
    // When the caller supplies `fields` it is used VERBATIM (so a test can model
    // a node with no body / no title); otherwise a default article field map.
    fields: fields ?? { title: "Old headline", body: "<p>Old body source</p>", nid: 5 },
  };
}
// The unwrapped { items, total, ... } data object callDrupalMcp returns for
// mcp_jsonapi_list_entities.
function mcpListEnvelope(...nodes: Record<string, unknown>[]) {
  return { items: nodes, total: nodes.length, limit: 1, offset: 0, has_more: false };
}
// Route the single callDrupalMcp mock by tool name: PRIMARY read vs fallback.
function routeCallDrupalMcp(routes: {
  read?: (args: Record<string, unknown>) => unknown;
  fallback?: (args: Record<string, unknown>) => unknown;
}) {
  vi.mocked(callDrupalMcp).mockImplementation(async (_inst, tool, args) => {
    if (tool === DRUPAL_NODE_GET_READ_TOOL) {
      if (!routes.read) throw new Error(`unexpected MCP read call: ${tool}`);
      return routes.read(args as Record<string, unknown>);
    }
    if (tool === DRUPAL_NODE_GET_FALLBACK_TOOL) {
      if (!routes.fallback) throw new Error(`unexpected fallback call: ${tool}`);
      return routes.fallback(args as Record<string, unknown>);
    }
    throw new Error(`unexpected tool: ${tool}`);
  });
}

describe("createDrupalPrimitiveHandlers", () => {
  let handlers: ReturnType<typeof createDrupalPrimitiveHandlers>;
  beforeEach(() => {
    handlers = createDrupalPrimitiveHandlers();
    listMcpInstancesMock.mockReset();
    listMcpInstancesMock.mockReturnValue([]);
    getApiStatusMock.mockClear();
    // Reset the write-authority gate to its default ALLOW behavior each test.
    requireInstanceWriteAuthorityMock.mockReset();
    requireInstanceWriteAuthorityMock.mockResolvedValue(undefined);
    vi.mocked(callDrupalMcp).mockReset();
    registerHandlersDepsStub();
  });

  afterEach(() => {
    _resetDrupalDepsForTests();
  });

  it("drupal_status reads the host-bound aggregate status via the deps slot", async () => {
    getApiStatusMock.mockResolvedValueOnce({
      instanceCount: 1,
      instances: [{ id: "a", name: "Site", siteUrl: "http://localhost:8082" }] as any[],
    });
    const result = await (handlers as any).drupal_status({
      primitiveName: "drupal_status",
      input: {},
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({
      instanceCount: 1,
      instances: [{ id: "a", name: "Site", siteUrl: "http://localhost:8082" }],
    });
    expect(getApiStatusMock).toHaveBeenCalledTimes(1);
  });

  it("drupal_instances_list sorts most-recently-updated first (the host listDrupalInstances ordering)", async () => {
    listMcpInstancesMock.mockReturnValue([
      { ...inst({ id: "old" }), updatedAt: "2026-01-01T00:00:00Z" },
      { ...inst({ id: "new" }), updatedAt: "2026-02-01T00:00:00Z" },
    ]);
    const result = (await (handlers as any).drupal_instances_list({
      primitiveName: "drupal_instances_list",
      input: {},
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    })) as any[];
    expect(result.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("drupal_instances_list redacts the Nango credential binding at the read boundary", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "a" }), inst({ id: "b" })]);
    const result = (await (handlers as any).drupal_instances_list({
      primitiveName: "drupal_instances_list",
      input: {},
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    })) as any;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    // The LLM tool caller must NEVER receive the credential binding: the vault
    // slot (nangoConnectionId/providerConfigKey) is what a caller could use to
    // reach the site's stored credential.
    expect(result[0].nangoConnectionId).toBeUndefined();
    expect(result[0].providerConfigKey).toBeUndefined();
    expect(result[0].mcpApiKey).toBeUndefined();
    // Non-secret display fields are preserved.
    expect(result[0].id).toBe("a");
    expect(result[0].name).toBe("Site 1");
    expect(result[0].siteUrl).toBe("http://localhost:8082");
    expect(result[0].createdAt).toBe("2026-01-01T00:00:00Z");
    // Belt-and-braces: no key on any row carries the binding, so a JSON.stringify
    // of the tool result (what the registry emits to the LLM) cannot leak it.
    expect(JSON.stringify(result)).not.toMatch(/nangoConnectionId|providerConfigKey/);
  });

  it("drupal_node_get throws when instanceId not found", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    await expect(
      (handlers as any).drupal_node_get({
        primitiveName: "drupal_node_get",
        input: { instanceId: "missing", nodeId: "5" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/instance not found/i);
  });

  it("drupal_node_get falls back to mcp_tools_get_recent_content when the MCP jsonapi read is unavailable", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    // MCP jsonapi read unavailable (mcp_tools_jsonapi disabled / restricted) →
    // handler falls back to the summary lookup (same /_mcp_tools transport).
    routeCallDrupalMcp({
      read: () => {
        throw new Error("mcp_tools_jsonapi not enabled");
      },
      // Response shape after callDrupalMcp unwraps the data envelope: { content: [...] }
      fallback: () => ({ content: [{ id: "5", title: "Hi" }] }),
    });
    const result = await (handlers as any).drupal_node_get({
      primitiveName: "drupal_node_get",
      input: { instanceId: "site-1", nodeId: "5" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    // PRIMARY read attempted first...
    expect(callDrupalMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      DRUPAL_NODE_GET_READ_TOOL,
      expect.objectContaining({ entity_type: "node", filters: { nid: 5 }, limit: 1 }),
    );
    // ...then the summary fallback.
    expect(callDrupalMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      DRUPAL_NODE_GET_FALLBACK_TOOL,
      expect.objectContaining({ limit: 100 }),
    );
    expect(result).toMatchObject({ id: "5", title: "Hi" });
  });

  it("drupal_node_get throws when node id not in the MCP read or the recent list", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    // MCP read REACHABLE but node absent (empty items) → falls through to the
    // summary lookup, which also misses → not-found throw.
    routeCallDrupalMcp({
      read: () => mcpListEnvelope(),
      fallback: () => ({ content: [{ id: "99", title: "Other" }] }),
    });
    await expect(
      (handlers as any).drupal_node_get({
        primitiveName: "drupal_node_get",
        input: { instanceId: "site-1", nodeId: "5" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/not found/i);
    // Both the primary read and the fallback were consulted.
    expect(callDrupalMcp).toHaveBeenCalledWith(expect.anything(), DRUPAL_NODE_GET_READ_TOOL, expect.anything());
    expect(callDrupalMcp).toHaveBeenCalledWith(expect.anything(), DRUPAL_NODE_GET_FALLBACK_TOOL, expect.anything());
  });

  // ---- The field-level-diff fix: MCP-primary full-field read (cinatra#1214 S2) ----
  // The agent's STEP 1 read must surface editable before-values (notably the raw
  // `body` source HTML) so STEP 4 can emit a real before/after change set, the
  // same way the WordPress agent's `wordpress_post_get` full read does — but over
  // the Drupal MCP module (mcp_jsonapi_list_entities), NOT a direct /jsonapi/* fetch.

  it("drupal_node_get reads the full node over MCP (mcp_jsonapi_list_entities) and flattens body.value to a top-level string", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    // The MCP module already flattened the compound `body` field to its raw
    // `.value` in `fields.body` (never the rendered `processed` output — proven
    // live in the S2 wire capture).
    routeCallDrupalMcp({
      read: () =>
        mcpListEnvelope(
          serializedNode({
            id: 5,
            uuid: "uuid-123",
            bundle: "article",
            label: "Old headline",
            status: true,
            fields: { title: "Old headline", body: "<p>Old body source</p>", nid: 5 },
          }),
        ),
    });

    const result = (await (handlers as any).drupal_node_get({
      primitiveName: "drupal_node_get",
      input: { instanceId: "site-1", nodeId: "5" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    })) as any;

    // The read is a SINGLE MCP call to the jsonapi read tool, filtered by nid.
    expect(callDrupalMcp).toHaveBeenCalledTimes(1);
    expect(callDrupalMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      DRUPAL_NODE_GET_READ_TOOL,
      expect.objectContaining({ entity_type: "node", filters: { nid: 5 }, limit: 1 }),
    );
    // The summary fallback must NOT be consulted when the MCP read succeeds.
    expect(callDrupalMcp).not.toHaveBeenCalledWith(
      expect.anything(),
      DRUPAL_NODE_GET_FALLBACK_TOOL,
      expect.anything(),
    );
    // Editable before-values are present at the top level for the agent to diff.
    expect(result.id).toBe("5");
    expect(result.nid).toBe(5);
    expect(result.uuid).toBe("uuid-123");
    expect(result.bundle).toBe("article");
    expect(result.title).toBe("Old headline");
    expect(result.status).toBe(true);
    // body is the raw source `value` the module surfaced as fields.body.
    expect(result.body).toBe("<p>Old body source</p>");
  });

  it("drupal_node_get is bundle-agnostic — one MCP read filtered by nid, no per-bundle enumeration", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    // The node entity query spans every bundle; a page node comes back from the
    // same single filtered read with no bundle discovery round-trips.
    routeCallDrupalMcp({
      read: (args) => {
        expect(args).toMatchObject({ entity_type: "node", filters: { nid: 7 }, limit: 1 });
        return mcpListEnvelope(
          serializedNode({ id: 7, uuid: "uuid-7", bundle: "page", label: "Found", fields: { title: "Found", body: "B", nid: 7 } }),
        );
      },
    });

    const result = (await (handlers as any).drupal_node_get({
      primitiveName: "drupal_node_get",
      input: { instanceId: "site-1", nodeId: "7" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    })) as any;

    expect(result.nid).toBe(7);
    expect(result.bundle).toBe("page");
    expect(result.body).toBe("B");
    // Exactly one MCP call — the old JSON:API path made a bundle-list + per-bundle
    // queries; the MCP read collapses that to a single nid-filtered call.
    expect(callDrupalMcp).toHaveBeenCalledTimes(1);
  });

  it("drupal_node_get defaults body/summary to empty string when the node has no body field", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    routeCallDrupalMcp({
      read: () =>
        mcpListEnvelope(
          // A bare page: fields carries only title/nid, no body.
          serializedNode({ id: 9, uuid: "uuid-9", bundle: "page", label: "Bare page", fields: { title: "Bare page", nid: 9 } }),
        ),
    });

    const result = (await (handlers as any).drupal_node_get({
      primitiveName: "drupal_node_get",
      input: { instanceId: "site-1", nodeId: "9" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    })) as any;

    expect(result.title).toBe("Bare page");
    expect(result.body).toBe("");
    // serializeEntity collapses body to its `.value`, so the text-summary
    // sub-value is not carried over MCP; the flatten defaults summary to "".
    expect(result.summary).toBe("");
  });

  it("drupal_node_get falls back to the entity label for title when fields.title is absent", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    routeCallDrupalMcp({
      read: () =>
        mcpListEnvelope(
          serializedNode({ id: 3, uuid: "uuid-3", bundle: "article", label: "Label headline", fields: { body: "hi", nid: 3 } }),
        ),
    });
    const result = (await (handlers as any).drupal_node_get({
      primitiveName: "drupal_node_get",
      input: { instanceId: "site-1", nodeId: "3" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    })) as any;
    expect(result.title).toBe("Label headline");
  });

  it("drupal_node_get rejects an invalid nodeId BEFORE any read (no MCP read, no summary fallback)", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    await expect(
      (handlers as any).drupal_node_get({
        primitiveName: "drupal_node_get",
        input: { instanceId: "site-1", nodeId: "0" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/not a positive integer/i);
    // Validation throws before the handler touches the MCP read or the summary tool.
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("drupal_node_update dispatches to mcp_update_content with nid + updates object intact", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    vi.mocked(callDrupalMcp).mockResolvedValue({ ok: true });
    await (handlers as any).drupal_node_update({
      primitiveName: "drupal_node_update",
      input: { instanceId: "site-1", nodeId: "5", fields: { title: "New", body: "Body" } },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(callDrupalMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      DRUPAL_NODE_UPDATE_TOOL,
      // Handler passes nid as a string to match the mcp_tools runtime contract.
      expect.objectContaining({ nid: "5", updates: expect.objectContaining({ title: "New" }) }),
    );
  });

  it("drupal_node_create_draft_revision dispatches to mcp_create_content with status:false", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    vi.mocked(callDrupalMcp).mockResolvedValue({ nid: 10 });
    await (handlers as any).drupal_node_create_draft_revision({
      primitiveName: "drupal_node_create_draft_revision",
      input: { instanceId: "site-1", nodeBundle: "article", title: "Draft" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(callDrupalMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      DRUPAL_NODE_CREATE_DRAFT_TOOL,
      expect.objectContaining({ status: false }),
    );
  });

  it("drupal_node_update strips empty-string field values before dispatch", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    vi.mocked(callDrupalMcp).mockResolvedValue({ ok: true });

    await (handlers as any).drupal_node_update({
      primitiveName: "drupal_node_update",
      input: {
        instanceId: "site-1",
        nodeId: "5",
        // LLM emits an empty body alongside a real title, which must not clear
        // useful existing content.
        fields: { title: "New title", body: "", excerpt: "" },
      },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

    const [, , args] = vi.mocked(callDrupalMcp).mock.calls[0];
    expect(args).toEqual(
      expect.objectContaining({
        nid: "5",                              // String(nid), per existing handler
        updates: { title: "New title" },       // body and excerpt MUST be absent
      }),
    );
    // Belt-and-braces — assert the keys are not present at all.
    expect((args as any).updates).not.toHaveProperty("body");
    expect((args as any).updates).not.toHaveProperty("excerpt");
  });

  it("drupal_node_create_draft_revision strips empty-string field values before dispatch", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    vi.mocked(callDrupalMcp).mockResolvedValue({ nid: 10 });

    await (handlers as any).drupal_node_create_draft_revision({
      primitiveName: "drupal_node_create_draft_revision",
      input: {
        instanceId: "site-1",
        nodeBundle: "article",
        title: "Draft",
        fields: { body: "", summary: "Real summary" },
      },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

    const [, , args] = vi.mocked(callDrupalMcp).mock.calls[0];
    expect((args as any).fields).not.toHaveProperty("body");
    expect((args as any).fields).toHaveProperty("summary", "Real summary");
  });

  // The handler comment documents the invariant: only literal "" is dropped;
  // null/undefined/false/0 pass through unchanged. Without this test, a
  // refactor that switched `v !== ""` to a truthiness check (Boolean(v),
  // `v != null && v !== ""`, etc.) would silently break boolean-clear
  // semantics with no failing test.
  it("drupal_node_update preserves null/false/0 — only \"\" is filtered", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    vi.mocked(callDrupalMcp).mockResolvedValue({ ok: true });

    await (handlers as any).drupal_node_update({
      primitiveName: "drupal_node_update",
      input: {
        instanceId: "site-1",
        nodeId: "5",
        fields: { title: "T", body: "", featured: false, count: 0, tagline: null },
      },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

    const [, , args] = vi.mocked(callDrupalMcp).mock.calls[0];
    // Pin the full updates shape — only `body: ""` should be dropped.
    expect((args as any).updates).toEqual({
      title: "T",
      featured: false,
      count: 0,
      tagline: null,
    });
  });

  // The strip filter alone would let the handler dispatch an empty `updates`
  // object, which Drupal would treat as a no-op while the agent assumed
  // success. The runtime throw closes that hole; this test pins it so a
  // future refactor that deletes the guard fails loudly.
  it("drupal_node_update throws when ALL fields are empty strings (no MCP call dispatched)", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    vi.mocked(callDrupalMcp).mockResolvedValue({ ok: true });

    await expect(
      (handlers as any).drupal_node_update({
        primitiveName: "drupal_node_update",
        input: {
          instanceId: "site-1",
          nodeId: "5",
          fields: { body: "", excerpt: "" },
        },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/all submitted fields were empty/i);

    // Belt-and-braces: the throw must fire BEFORE callDrupalMcp is invoked.
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("drupal_node_publish dispatches to mcp_publish_content with nid and publish:true", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    vi.mocked(callDrupalMcp).mockResolvedValue("published");
    await (handlers as any).drupal_node_publish({
      primitiveName: "drupal_node_publish",
      input: { instanceId: "site-1", nodeId: "5" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(callDrupalMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      DRUPAL_NODE_PUBLISH_TOOL,
      // Handler passes nid as a string to match the mcp_tools runtime contract.
      expect.objectContaining({ nid: "5", publish: true }),
    );
  });

  it("validates input via zod and rejects empty instanceId", async () => {
    await expect(
      (handlers as any).drupal_node_get({
        primitiveName: "drupal_node_get",
        input: { instanceId: "", nodeId: "5" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow();
  });

  it("registers exactly 8 primitives (status, instances_list, node_get, node_update, node_create_draft_revision, node_list, node_publish, content_editor_run)", () => {
    const keys = Object.keys(handlers as any).sort();
    expect(keys).toEqual([
      "drupal_content_editor_run",
      "drupal_instances_list",
      "drupal_node_create_draft_revision",
      "drupal_node_get",
      "drupal_node_list",
      "drupal_node_publish",
      "drupal_node_update",
      "drupal_status",
    ]);
  });
});

// ---------------------------------------------------------------------------
// drupal_content_editor_run A2A dispatch
//
// The A2A transport (bearer mint + client + sendTask + task.history walk) now
// lives HOST-side behind `deps.dispatchContentEditor`, which resolves with the
// agent's reply TEXT. These tests register a deps stub and assert the
// connector's stripCodeFences + JSON.parse of that text, plus that dispatch is
// invoked with the resolved agentUrl + 300s budget + the validated input object.
// ---------------------------------------------------------------------------

import {
  registerDrupalConnector,
  _resetDrupalDepsForTests,
} from "../deps";

const dispatchMock = vi.fn(
  async (_input: {
    agentUrl: string;
    payload: unknown;
    timeoutMs: number;
    packageName: string;
  }) => "",
);

function registerContentEditorDepsStub() {
  registerDrupalConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: dispatchMock,
    buildNangoBearerHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
    // External-MCP toolbox surfaces (unused by this suite's code paths).
    listMcpInstances: () => [],
    probeMcp: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl.replace(/\/+$/, "") + "/_mcp_tools",
    isPrivateUrl: () => false,
    isNangoConfigured: () => true,
    // Instance-admin surfaces (cinatra#172 Stage H2; unused by this suite).
    getApiStatus: vi.fn(async () => ({ instanceCount: 0, instances: [] })),
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: vi.fn(async () => []),
    // cinatra#409 — the content-editor RELAY is a dispatch primitive (it does
    // not call callDrupalMcp directly); the write authz runs in the leaf
    // agent's own MCP write tools. Stubbed allow here for contract completeness.
    requireInstanceWriteAuthority: vi.fn(async () => {}),
  });
}

describe("drupal_content_editor_run", () => {
  let handlers: ReturnType<typeof createDrupalPrimitiveHandlers>;
  beforeEach(() => {
    handlers = createDrupalPrimitiveHandlers();
    dispatchMock.mockReset();
    registerContentEditorDepsStub();
    delete process.env.DRUPAL_CONTENT_EDITOR_A2A_URL;
  });

  afterEach(() => {
    _resetDrupalDepsForTests();
  });

  it("dispatches with the default :3010 agent route when the env var is unset", async () => {
    // beforeEach already deletes the env var, but assert it explicitly so this test
    // documents the contract for future readers.
    delete process.env.DRUPAL_CONTENT_EDITOR_A2A_URL;
    expect(process.env.DRUPAL_CONTENT_EDITOR_A2A_URL).toBeUndefined();

    dispatchMock.mockResolvedValue("{}");

    await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: { instanceId: "site-1", nodeId: "5", instructions: "noop" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentUrl: "http://localhost:3010/agents/cinatra-ai/drupal-agent" }),
    );
  });

  it("is registered as a handler key on createDrupalPrimitiveHandlers()", () => {
    expect(typeof (handlers as any).drupal_content_editor_run).toBe("function");
  });

  it("rejects empty instanceId via zod schema", async () => {
    await expect(
      (handlers as any).drupal_content_editor_run({
        primitiveName: "drupal_content_editor_run",
        input: { instanceId: "", nodeId: "5", instructions: "Update title" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow();
  });

  it("calls dispatchContentEditor with default :3010 agent route and timeout 300_000", async () => {
    dispatchMock.mockResolvedValue('{"nodeId":"5","changes":[]}');
    await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: {
        instanceId: "site-1",
        nodeId: "5",
        nodeBundle: "article",
        nodeStatus: "draft",
        instructions: "Update title to Hello",
      },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUrl: "http://localhost:3010/agents/cinatra-ai/drupal-agent",
        timeoutMs: 300_000,
        // cinatra#246: agent package name drives host-side OBO run creation.
        packageName: "@cinatra-ai/drupal-agent",
      }),
    );
  });

  it("respects DRUPAL_CONTENT_EDITOR_A2A_URL when set", async () => {
    process.env.DRUPAL_CONTENT_EDITOR_A2A_URL = "http://wayflow-drupal-content-editor:3020";
    dispatchMock.mockResolvedValue("{}");
    await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: { instanceId: "site-1", nodeId: "5", instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentUrl: "http://wayflow-drupal-content-editor:3020" }),
    );
  });

  it("parses JSON from the dispatched reply text and returns it", async () => {
    dispatchMock.mockResolvedValue(
      '{"nodeId":"5","changes":[{"field":"title","before":"a","after":"b"}]}',
    );
    const result = await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: { instanceId: "site-1", nodeId: "5", instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({
      nodeId: "5",
      changes: [{ field: "title", before: "a", after: "b" }],
    });
  });

  it("forwards the validated input object as the dispatch payload", async () => {
    dispatchMock.mockResolvedValue('{"nodeId":"5","changes":[]}');
    await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: {
        instanceId: "site-1",
        nodeId: "5",
        nodeBundle: "article",
        instructions: "Update title to Hello",
      },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    const arg = dispatchMock.mock.calls[0][0] as {
      payload: {
        instanceId: string;
        nodeId: string;
        nodeBundle: string;
        instructions: string;
      };
    };
    expect(arg.payload.instanceId).toBe("site-1");
    expect(arg.payload.nodeId).toBe("5");
    expect(arg.payload.nodeBundle).toBe("article");
    expect(arg.payload.instructions).toBe("Update title to Hello");
  });

  it("strips Markdown code fences before JSON.parse", async () => {
    dispatchMock.mockResolvedValue('```json\n{"nodeId":"5","changes":[]}\n```');
    const result = await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: { instanceId: "site-1", nodeId: "5", instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ nodeId: "5", changes: [] });
  });

  it("falls back to { result: text } when the reply text is not JSON", async () => {
    dispatchMock.mockResolvedValue("plain text");
    const result = await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: { instanceId: "site-1", nodeId: "5", instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ result: "plain text" });
  });

  it("returns { result: '' } when the dispatch resolves empty text", async () => {
    dispatchMock.mockResolvedValue("");
    const result = await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: { instanceId: "site-1", nodeId: "5", instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ result: "" });
  });
});
