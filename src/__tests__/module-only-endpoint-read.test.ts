// A Cinatra development Drupal site serves exactly two tools on its MCP
// endpoint: cinatra_read_protected_revision and cinatra_write_protected_draft.
// The generic mcp_tools read tools are not served there. These tests require
// that drupal_node_get and the protected draft's identity read use the module
// reader on such an endpoint, that a malformed module field list refuses the
// read, that drupal_node_update never takes the module read as its status
// read, and that a site which serves the generic read keeps it as the primary
// read.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/drupal-mcp-client", () => ({ callDrupalMcp: vi.fn() }));
import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "../mcp/handlers";
import { registerDrupalConnector } from "../deps";
import {
  MODULE_READ_REVISION as READER,
  MODULE_WRITE_DRAFT as WRITER,
  PROTECTED_DRAFT_CONTRACT,
  type StoredFieldItems,
} from "../integration/module-protected-draft";

const GENERIC_READ = "mcp_jsonapi_list_entities";
const GENERIC_LIST = "mcp_tools_get_recent_content";
const instance = { id: "site", name: "Site", siteUrl: "https://example.test", nangoConnectionId: "site", providerConfigKey: "drupal", createdAt: "", updatedAt: "" };
const live: StoredFieldItems = {
  title: [{ value: "Live title" }],
  body: [{ value: "<p>Live body</p>", format: "basic_html", summary: "Live summary" }],
};
const preimage = {
  node_id: 7, uuid: "uuid-7", language: "de", default_revision_id: 10, latest_revision_id: 10,
  is_default_revision: true, is_published: true, moderated: true, canonical_moderation_field: true,
  workflow_fingerprint: "a".repeat(64), preimage_fingerprint: "c".repeat(64),
  draft_states: { draft: { published: false, default_revision: false } }, allowed_draft_states: ["draft"],
  available_fields: ["body", "title"], translation_languages: ["de"],
};
const envelope = (result: unknown) => ({ contract: PROTECTED_DRAFT_CONTRACT, result });
const authority = vi.fn(async () => {});

// Only the deps the read and draft primitives reach; the list helpers are unused.
function deps() {
  registerDrupalConnector({
    dispatchContentEditor: async () => "{}",
    buildNangoBearerHeader: async () => ({ Authorization: "Bearer unit" }), listMcpInstances: () => [instance],
    probeMcp: async () => "registered", resolveMcpServerUrl: (s: string) => s, isPrivateUrl: () => false,
    isNangoConfigured: () => true, getApiStatus: async () => ({ instanceCount: 1, instances: [] }),
    saveInstance: vi.fn(), deleteInstance: vi.fn(), listInstanceStatuses: async () => [],
    requireInstanceWriteAuthority: authority,
  } as unknown as Parameters<typeof registerDrupalConnector>[0]);
}

// An endpoint that serves ONLY the two module tools, like the armed dev site.
// The reader resolves an omitted language to the original translation.
function moduleOnlyEndpoint() {
  let saved = structuredClone(live);
  vi.mocked(callDrupalMcp).mockImplementation(async (_instance, tool, raw) => {
    const args = raw as Record<string, unknown>;
    const names = args.fields as string[];
    if (tool === READER) {
      if (args.language !== undefined && args.language !== "de") throw new Error("The exact page translation is not available.");
      if (args.revision_id !== undefined) {
        return envelope({ node_id: 7, uuid: "uuid-7", language: "de", revision_id: 11, default_revision_id: 10, is_default_revision: false, is_published: false, moderation_state: "draft", fields: Object.fromEntries(names.map((n) => [n, saved[n]])) });
      }
      return envelope({ ...preimage, fields: Object.fromEntries(names.map((n) => [n, live[n]])) });
    }
    if (tool === WRITER) {
      const updates = args.updates as StoredFieldItems;
      saved = { ...saved, ...updates };
      return envelope({ node_id: 7, uuid: "uuid-7", language: "de", revision_id: 11, default_revision_id: 10, is_default_revision: false, is_published: false, moderation_state: "draft", fields: Object.fromEntries(Object.keys(updates).map((n) => [n, saved[n]])) });
    }
    throw new Error(`Unknown tool: ${tool}`);
  });
}

// Rewrite the module reader's result; every other tool keeps the endpoint above.
function readerResult(change: (result: Record<string, unknown>, args: Record<string, unknown>) => Record<string, unknown>) {
  const base = vi.mocked(callDrupalMcp).getMockImplementation()!;
  vi.mocked(callDrupalMcp).mockImplementation(async (i, tool, raw) => {
    const value = await base(i, tool, raw) as { result: Record<string, unknown> };
    return tool === READER ? envelope(change(value.result, raw as Record<string, unknown>)) : value;
  });
}

const tools = () => vi.mocked(callDrupalMcp).mock.calls.map((c) => c[1]);
const readerCalls = () => vi.mocked(callDrupalMcp).mock.calls.filter((c) => c[1] === READER);
const writes = () => vi.mocked(callDrupalMcp).mock.calls.filter((c) => [WRITER, "mcp_update_content", "mcp_publish_content"].includes(c[1]));

beforeEach(() => { vi.clearAllMocks(); authority.mockResolvedValue(undefined); deps(); moduleOnlyEndpoint(); });

describe("an endpoint that serves only the Cinatra module tools", () => {
  it("drupal_node_get reads the node and its body source through the module reader", async () => {
    const node = await createDrupalPrimitiveHandlers().drupal_node_get({ input: { instanceId: "site", nodeId: "7" } } as never) as Record<string, unknown>;
    expect(node).toMatchObject({ id: "7", nid: 7, uuid: "uuid-7", langcode: "de", status: true, title: "Live title", body: "<p>Live body</p>", summary: "Live summary" });
    const reads = vi.mocked(callDrupalMcp).mock.calls.filter((c) => c[1] === READER);
    // The first module read names no language: the module binds the original
    // translation and reports it. Every later read binds that language.
    expect(reads[0][2]).toEqual({ nid: 7, fields: ["title"] });
    expect(reads.slice(1).every((c) => (c[2] as Record<string, unknown>).language === "de")).toBe(true);
    expect(tools()).not.toContain(GENERIC_LIST);
    expect(writes()).toHaveLength(0);
  });

  it("drupal_node_create_draft_revision reaches the module reader and writer", async () => {
    const result = await createDrupalPrimitiveHandlers().drupal_node_create_draft_revision({ input: { instanceId: "site", nodeId: "7", fields: { title: "Changed" } } } as never);
    expect(result).toMatchObject({ nodeId: "7", revision_id: 11, status: "draft", pendingDraft: { language: "de", fields: { title: [{ value: "Changed" }] } } });
    expect(writes()).toHaveLength(1);
    expect(writes()[0][2]).toMatchObject({ nid: 7, language: "de", draft_state: "draft", updates: { title: [{ value: "Changed" }] } });
  });

  it("refuses the draft when the module reader also fails", async () => {
    vi.mocked(callDrupalMcp).mockRejectedValue(new Error("Unknown tool"));
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision({ input: { instanceId: "site", nodeId: "7", fields: { title: "Changed" } } } as never)).rejects.toThrow(/published node identity/i);
    // The identity read tried the module reader before it refused.
    expect(readerCalls()[0]?.[2]).toEqual({ nid: 7, fields: ["title"] });
    expect(writes()).toHaveLength(0);
  });

  it("refuses the draft when the identity read names another node", async () => {
    // Only the identity read (no language) names node 8. The language-bound
    // reads name node 7, so only the identity check of that read refuses.
    readerResult((result, args) => args.language === undefined ? { ...result, node_id: 8 } : result);
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision({ input: { instanceId: "site", nodeId: "7", fields: { title: "Changed" } } } as never)).rejects.toThrow(/published node identity/i);
    expect(readerCalls()).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it("refuses a module read without a field list and falls back to the summary", async () => {
    readerResult((result) => ({ ...result, available_fields: null }));
    await expect(createDrupalPrimitiveHandlers().drupal_node_get({ input: { instanceId: "site", nodeId: "7" } } as never)).rejects.toThrow(/mcp_tools_get_recent_content/);
    expect(readerCalls()).toHaveLength(1);
    expect(tools()).toContain(GENERIC_LIST);
  });

  it("refuses a module read whose field list holds an invalid entry and falls back to the summary", async () => {
    readerResult((result) => ({ ...result, available_fields: ["body", "title", 42] }));
    await expect(createDrupalPrimitiveHandlers().drupal_node_get({ input: { instanceId: "site", nodeId: "7" } } as never)).rejects.toThrow(/mcp_tools_get_recent_content/);
    expect(readerCalls()).toHaveLength(1);
    expect(tools()).toContain(GENERIC_LIST);
  });

  it("refuses a module read whose field list is empty and falls back to the summary", async () => {
    readerResult((result) => ({ ...result, available_fields: [] }));
    await expect(createDrupalPrimitiveHandlers().drupal_node_get({ input: { instanceId: "site", nodeId: "7" } } as never)).rejects.toThrow(/mcp_tools_get_recent_content/);
    expect(readerCalls()).toHaveLength(1);
    expect(tools()).toContain(GENERIC_LIST);
  });

  it.each([
    ["the field list", { available_fields: ["body", "field_deck", "title"] }],
    ["the UUID", { uuid: "uuid-other" }],
    ["the default revision", { default_revision_id: 12 }],
  ])("refuses the read when %s changes between the module reads and falls back to the summary", async (_name, change) => {
    // Only the language-bound (second) read reports the change.
    readerResult((result, args) => args.language === undefined ? result : { ...result, ...change });
    await expect(createDrupalPrimitiveHandlers().drupal_node_get({ input: { instanceId: "site", nodeId: "7" } } as never)).rejects.toThrow(/mcp_tools_get_recent_content/);
    expect(readerCalls()).toHaveLength(2);
    expect(tools()).toContain(GENERIC_LIST);
  });

  it("skips the language-bound read when title is the only editable field", async () => {
    readerResult((result) => ({ ...result, available_fields: ["title"] }));
    const node = await createDrupalPrimitiveHandlers().drupal_node_get({ input: { instanceId: "site", nodeId: "7" } } as never) as Record<string, unknown>;
    expect(node).toMatchObject({ id: "7", nid: 7, uuid: "uuid-7", langcode: "de", status: true, title: "Live title", body: "", summary: "" });
    expect(readerCalls().map((c) => c[2])).toEqual([{ nid: 7, fields: ["title"] }]);
    expect(tools()).not.toContain(GENERIC_LIST);
  });

  it("drupal_node_update refuses when only the module reader can read the node", async () => {
    // The module reads would succeed and report an unpublished node, and the
    // generic update tool is served. The update's status guard reads only
    // through the generic read, so the update is refused.
    const base = vi.mocked(callDrupalMcp).getMockImplementation()!;
    vi.mocked(callDrupalMcp).mockImplementation(async (i, tool, raw) => {
      if (tool === "mcp_update_content") return { success: true };
      const value = await base(i, tool, raw) as { result: Record<string, unknown> };
      return tool === READER ? envelope({ ...value.result, is_published: false }) : value;
    });
    await expect(createDrupalPrimitiveHandlers().drupal_node_update({ input: { instanceId: "site", nodeId: "7", fields: { title: "Changed" } } } as never)).rejects.toThrow("Cannot establish current node status (read unavailable or unsupported); refusing a content update.");
    expect(tools()).toEqual([GENERIC_READ]);
    expect(writes()).toHaveLength(0);
  });
});

describe("an endpoint that serves the generic read", () => {
  it("keeps mcp_jsonapi_list_entities as the primary read and never calls the module reader for drupal_node_get", async () => {
    vi.mocked(callDrupalMcp).mockImplementation(async (_i, tool) => {
      if (tool === GENERIC_READ) return { items: [{ entity_type: "node", id: 7, uuid: "uuid-7", status: true, fields: { nid: 7, langcode: "en", title: "Generic", body: "Generic body" } }] };
      throw new Error(`Unexpected tool: ${tool}`);
    });
    const node = await createDrupalPrimitiveHandlers().drupal_node_get({ input: { instanceId: "site", nodeId: "7" } } as never);
    expect(node).toMatchObject({ title: "Generic", body: "Generic body", langcode: "en" });
    expect(tools()).toEqual([GENERIC_READ]);
  });
});
