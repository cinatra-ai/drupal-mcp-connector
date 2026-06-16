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
  });
}

// Actual tool names discovered 2026-04-27 against Drupal 11 + mcp_tools ^1.0@beta:
// drupal_node_get uses mcp_tools_get_recent_content because search requires
// >=3 chars and does not support nid-specific lookup.
const DRUPAL_NODE_GET_TOOL = "mcp_tools_get_recent_content";
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

describe("createDrupalPrimitiveHandlers", () => {
  let handlers: ReturnType<typeof createDrupalPrimitiveHandlers>;
  beforeEach(() => {
    handlers = createDrupalPrimitiveHandlers();
    listMcpInstancesMock.mockReset();
    listMcpInstancesMock.mockReturnValue([]);
    getApiStatusMock.mockClear();
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

  it("drupal_instances_list returns the configured instances with no credential-bearing field", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "a" }), inst({ id: "b" })]);
    const result = (await (handlers as any).drupal_instances_list({
      primitiveName: "drupal_instances_list",
      input: {},
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    })) as any;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    // No secret is stored in the row at all. nangoConnectionId is a pointer,
    // not a credential, and is safe to expose.
    expect(result[0].mcpApiKey).toBeUndefined();
    expect(result[0].nangoConnectionId).toBe("a");
    expect(result[0].providerConfigKey).toBe("cinatra-drupal");
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

  it("drupal_node_get dispatches to mcp_tools_get_recent_content and finds node by id", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    // Response shape after callDrupalMcp unwraps the data envelope: { content: [...] }
    vi.mocked(callDrupalMcp).mockResolvedValue({ content: [{ id: "5", title: "Hi" }] });
    const result = await (handlers as any).drupal_node_get({
      primitiveName: "drupal_node_get",
      input: { instanceId: "site-1", nodeId: "5" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(callDrupalMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      DRUPAL_NODE_GET_TOOL,
      expect.objectContaining({ limit: 100 }),
    );
    expect(result).toMatchObject({ id: "5", title: "Hi" });
  });

  it("drupal_node_get throws when node id not in recent list", async () => {
    listMcpInstancesMock.mockReturnValue([inst({ id: "site-1" })]);
    vi.mocked(callDrupalMcp).mockResolvedValue({ content: [{ id: "99", title: "Other" }] });
    await expect(
      (handlers as any).drupal_node_get({
        primitiveName: "drupal_node_get",
        input: { instanceId: "site-1", nodeId: "5" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/not found/i);
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
// invoked with the resolved agentUrl + 300s budget + serialized input.
// ---------------------------------------------------------------------------

import {
  registerDrupalConnector,
  _resetDrupalDepsForTests,
} from "../deps";

const dispatchMock = vi.fn(
  async (_input: {
    agentUrl: string;
    payload: string;
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

  it("dispatches with the default agentUrl http://localhost:3020 when the env var is unset", async () => {
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
      expect.objectContaining({ agentUrl: "http://localhost:3020" }),
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

  it("calls dispatchContentEditor with default localhost:3020 and timeout 300_000", async () => {
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
        agentUrl: "http://localhost:3020",
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

  it("serializes the validated input into the dispatch payload", async () => {
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
    const arg = dispatchMock.mock.calls[0][0] as { payload: string };
    const payload = JSON.parse(arg.payload);
    expect(payload.instanceId).toBe("site-1");
    expect(payload.nodeId).toBe("5");
    expect(payload.nodeBundle).toBe("article");
    expect(payload.instructions).toBe("Update title to Hello");
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
