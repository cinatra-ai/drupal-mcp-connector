// cinatra#3745 (owner decision 1234 A): an agent's Drupal page edit reads the
// page and writes the reviewed change through flow steps without a model, and
// each write happens only if the page is unchanged since the read the review
// was based on. The read tool returns the module's binding; the write tools
// pass that binding to the Cinatra module's own tools, which compare it again
// under the node lock. Without a binding every write tool behaves as before.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
vi.mock("../lib/drupal-mcp-client", () => ({ callDrupalMcp: vi.fn(), listDrupalMcpToolNames: vi.fn() }));
import { callDrupalMcp, listDrupalMcpToolNames } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "../mcp/handlers";
import { registerDrupalPrimitives } from "../mcp/registry";
import { registerDrupalConnector } from "../deps";
import { MODULE_READ_REVISION as READER, MODULE_WRITE_DRAFT as DRAFT_WRITER, PROTECTED_DRAFT_CONTRACT, type StoredFieldItems } from "../integration/module-protected-draft";
import {
  MODULE_WRITE_UNPUBLISHED as WRITE_UNPUBLISHED, MODULE_PUBLISH_UNPUBLISHED as PUBLISH_UNPUBLISHED,
  JSON_ARGUMENT_MAX_BYTES, type EditBinding,
} from "../integration/edit-binding";

const instance = { id: "site", name: "Site", siteUrl: "https://example.test", nangoConnectionId: "site", providerConfigKey: "drupal", createdAt: "", updatedAt: "" };
const A = "a".repeat(64);
const C = "c".repeat(64);
const before: StoredFieldItems = { title: [{ value: "Old" }], body: [{ value: "Old body", format: "basic_html", summary: "Keep" }] };
const unpublishedRead = { node_id: 7, uuid: "uuid-7", language: "de", default_revision_id: 10, latest_revision_id: 10, is_default_revision: true, is_published: false, changed: 1700000000, moderated: false, canonical_moderation_field: false, workflow_fingerprint: A, preimage_fingerprint: C, draft_states: {}, allowed_draft_states: [], available_fields: ["body", "title"] };
const publishedRead = { ...unpublishedRead, is_published: true, moderated: true, canonical_moderation_field: true, draft_states: { draft: { published: false, default_revision: false } }, allowed_draft_states: ["draft"] };
const binding: EditBinding = { nid: 7, language: "de", published: false, expected_default_revision_id: 10, expected_latest_revision_id: 10, expected_changed: 1700000000, workflow_fingerprint: A, preimage_fingerprint: C };
const publishedBinding: EditBinding = { ...binding, published: true };
const envelope = (result: unknown) => ({ contract: PROTECTED_DRAFT_CONTRACT, result });
const authority = vi.fn(async () => {});
const ALL_TOOLS = [READER, DRAFT_WRITER, WRITE_UNPUBLISHED, PUBLISH_UNPUBLISHED];
const THIRD_PARTY = ["mcp_update_content", "mcp_publish_content", "mcp_jsonapi_list_entities", "mcp_tools_get_recent_content", "mcp_create_content"];

function deps() {
  registerDrupalConnector({ decodeCursor: () => 0, buildListPage: (items, total) => ({ items, total }), dispatchContentEditor: async () => "{}", buildNangoBearerHeader: async () => ({ Authorization: "Bearer unit" }), listMcpInstances: () => [instance], probeMcp: async () => "registered", resolveMcpServerUrl: (s) => s, isPrivateUrl: () => false, isNangoConfigured: () => true, getApiStatus: async () => ({ instanceCount: 1, instances: [] }), saveInstance: vi.fn(), deleteInstance: vi.fn(), listInstanceStatuses: async () => [], requireInstanceWriteAuthority: authority });
}

type Route = { read?: Record<string, unknown>; secondRead?: Record<string, unknown>; writeFailure?: string; writeThrows?: string; writeResult?: Record<string, unknown>; fields?: StoredFieldItems };
function route(o: Route = {}) {
  let reads = 0;
  const source = o.fields ?? before;
  let saved: StoredFieldItems = structuredClone(source);
  vi.mocked(callDrupalMcp).mockImplementation(async (_instance, tool, raw) => {
    const args = raw as Record<string, unknown>;
    if (tool === READER && args.revision_id !== undefined) {
      const names = args.fields as string[];
      return envelope({ node_id: 7, uuid: "uuid-7", language: args.language, revision_id: args.revision_id, default_revision_id: 10, is_default_revision: false, is_published: false, moderation_state: "draft", fields: Object.fromEntries(names.map((name) => [name, saved[name]])) });
    }
    if (tool === READER) {
      const names = args.fields as string[];
      const base = o.read ?? unpublishedRead;
      const result = { ...base, fields: Object.fromEntries(names.map((name) => [name, source[name]])), ...(reads++ ? o.secondRead : {}) };
      return envelope(result);
    }
    if (tool === WRITE_UNPUBLISHED || tool === PUBLISH_UNPUBLISHED || tool === DRAFT_WRITER) {
      if (o.writeFailure !== undefined) throw new Error(`Drupal ${tool} returned failure: ${o.writeFailure}`);
      if (o.writeThrows !== undefined) throw new Error(o.writeThrows);
      const updates = (args.updates ?? {}) as StoredFieldItems;
      saved = { ...saved, ...updates };
      if (tool === DRAFT_WRITER) {
        return envelope({ node_id: 7, uuid: "uuid-7", language: args.language, revision_id: 11, default_revision_id: 10, is_default_revision: false, is_published: false, moderation_state: "draft", fields: updates, ...o.writeResult });
      }
      const publish = tool === PUBLISH_UNPUBLISHED || args.publish === true;
      return envelope({ node_id: 7, uuid: "uuid-7", language: args.language, revision_id: 11, is_default_revision: true, is_published: publish, changed: 1700000100, fields: tool === PUBLISH_UNPUBLISHED ? [] : updates, ...o.writeResult });
    }
    throw new Error(`Unexpected tool: ${tool}`);
  });
}
const calls = () => vi.mocked(callDrupalMcp).mock.calls;
const toolsCalled = () => calls().map((c) => c[1]);
const writes = () => calls().filter((c) => [DRAFT_WRITER, WRITE_UNPUBLISHED, PUBLISH_UNPUBLISHED, "mcp_update_content", "mcp_publish_content", "mcp_create_content"].includes(c[1]));
const handlers = () => createDrupalPrimitiveHandlers();
const call = (name: keyof ReturnType<typeof createDrupalPrimitiveHandlers>, input: Record<string, unknown>) =>
  (handlers()[name] as (r: unknown) => Promise<unknown>)({ input, primitiveName: name, actor: {}, mode: "agentic" });
async function failure(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  vi.clearAllMocks();
  authority.mockResolvedValue(undefined);
  deps();
  route();
  vi.mocked(listDrupalMcpToolNames).mockResolvedValue([...ALL_TOOLS]);
});

describe("drupal_node_read_for_edit", () => {
  it("calls only the module reader, without a revision, and returns every field value with the binding", async () => {
    const result = await call("drupal_node_read_for_edit", { instanceId: "site", nid: "7" }) as Record<string, unknown>;
    expect(toolsCalled()).toEqual([READER, READER]);
    expect(calls()[0][2]).toEqual({ nid: 7, fields: ["title"] });
    expect(calls()[1][2]).toEqual({ nid: 7, language: "de", fields: ["body", "title"] });
    for (const c of calls()) expect(c[2]).not.toHaveProperty("revision_id");
    expect(listDrupalMcpToolNames).not.toHaveBeenCalled();
    expect(authority).not.toHaveBeenCalled();
    expect(result).toEqual({
      nodeId: "7", nid: 7, uuid: "uuid-7", language: "de", published: false,
      fields: { title: "Old", body: "Old body" },
      stored_fields: before,
      available_fields: ["body", "title"],
      binding,
    });
  });

  it("passes an explicit language to the first read and accepts a numeric nid", async () => {
    await call("drupal_node_read_for_edit", { instanceId: "site", nid: 7, language: "de" });
    expect(calls()[0][2]).toEqual({ nid: 7, language: "de", fields: ["title"] });
  });

  it("reports a published page in the binding so the flow can branch", async () => {
    route({ read: publishedRead });
    const result = await call("drupal_node_read_for_edit", { instanceId: "site", nid: "7" }) as { published: boolean; binding: EditBinding };
    expect(result.published).toBe(true);
    expect(result.binding).toEqual(publishedBinding);
  });

  it("gives a binding a template can carry as JSON text unchanged", async () => {
    const result = await call("drupal_node_read_for_edit", { instanceId: "site", nid: "7" }) as { binding: EditBinding };
    expect(JSON.parse(JSON.stringify(result.binding))).toEqual(result.binding);
  });

  it("refuses an older module whose read returns no changed time", async () => {
    const { changed: _changed, ...old } = unpublishedRead;
    route({ read: old });
    expect(await failure(call("drupal_node_read_for_edit", { instanceId: "site", nid: "7" }))).toMatch(/^module_capability_missing: /);
  });

  it("refuses a read whose binding moved between the two module reads", async () => {
    route({ secondRead: { default_revision_id: 12, latest_revision_id: 12 } });
    expect(await failure(call("drupal_node_read_for_edit", { instanceId: "site", nid: "7" }))).toMatch(/^node_changed: /);
  });

  it.each([["missing fingerprint", { workflow_fingerprint: "short" }], ["not the default revision", { is_default_revision: false }], ["other language", { language: "en" }]])("refuses a malformed module read (%s)", async (_name, read) => {
    route({ secondRead: read });
    await expect(call("drupal_node_read_for_edit", { instanceId: "site", nid: "7" })).rejects.toThrow();
  });

  it("refuses an invalid node id before any call", async () => {
    await expect(call("drupal_node_read_for_edit", { instanceId: "site", nid: "0" })).rejects.toThrow();
    await expect(call("drupal_node_read_for_edit", { instanceId: "site", nid: "7", fields: {} })).rejects.toThrow();
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });
});

describe("registry declarations", () => {
  function configs(): Map<string, Record<string, unknown>> {
    const seen = new Map<string, Record<string, unknown>>();
    registerDrupalPrimitives({ registerTool: (name: string, config: Record<string, unknown>) => { seen.set(name, config); } } as never);
    return seen;
  }
  it("declares passthroughStep read on the read tool and nothing outward on it", () => {
    const config = configs().get("drupal_node_read_for_edit");
    expect(config?.passthroughStep).toBe("read");
    expect(config && "outward" in config).toBe(false);
  });
  it("declares passthroughStep publishing on the three write tools and keeps outward on publish only", () => {
    const seen = configs();
    for (const name of ["drupal_node_update", "drupal_node_publish", "drupal_node_create_draft_revision"]) expect(seen.get(name)?.passthroughStep).toBe("publishing");
    expect(seen.get("drupal_node_publish")?.outward).toEqual({});
    expect([...seen].filter(([, c]) => "passthroughStep" in c).map(([n]) => n).sort()).toEqual(["drupal_node_create_draft_revision", "drupal_node_publish", "drupal_node_read_for_edit", "drupal_node_update"]);
  });
});

describe("drupal_node_update with expectedBinding", () => {
  it("writes through cinatra_write_unpublished with exactly the binding's values, never the third-party tools", async () => {
    const result = await call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { body: "New body" }, expectedBinding: binding });
    expect(authority).toHaveBeenCalledWith({ instanceId: "site", primitiveName: "drupal_node_update" });
    expect(toolsCalled()).toEqual([READER, WRITE_UNPUBLISHED]);
    expect(calls()[0][2]).toEqual({ nid: 7, language: "de", fields: ["body"] });
    expect(calls()[1][2]).toEqual({
      nid: 7, language: "de", expected_default_revision_id: 10, expected_latest_revision_id: 10, expected_changed: 1700000000,
      workflow_fingerprint: A, preimage_fingerprint: C,
      updates: { body: [{ value: "New body", format: "basic_html", summary: "Keep" }] },
    });
    expect(toolsCalled().some((t) => THIRD_PARTY.includes(t))).toBe(false);
    expect(result).toEqual({ nodeId: "7", nid: 7, language: "de", revision_id: 11, published: false, changed: 1700000100, applied: true, fields: { body: [{ value: "New body", format: "basic_html", summary: "Keep" }] } });
  });

  it("refuses with a fixed message naming the module capability when the site lacks cinatra_write_unpublished, and never falls back", async () => {
    vi.mocked(listDrupalMcpToolNames).mockResolvedValue([READER, DRAFT_WRITER, "mcp_update_content"]);
    const message = await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: binding }));
    expect(message).toMatch(/^module_capability_missing: .*cinatra_write_unpublished/);
    expect(writes()).toHaveLength(0);
    expect(toolsCalled().some((t) => THIRD_PARTY.includes(t))).toBe(false);
  });

  it("refuses when the site's tool list cannot be read", async () => {
    vi.mocked(listDrupalMcpToolNames).mockRejectedValue(new Error("private transport detail"));
    const message = await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: binding }));
    expect(message).toMatch(/^module_capability_missing: /);
    expect(message).not.toMatch(/private transport detail/);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("refuses a binding for a published page and points at the protected draft", async () => {
    expect(await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: publishedBinding }))).toMatch(/^wrong_page_state: .*drupal_node_create_draft_revision/);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["a missing member", (({ expected_changed: _c, ...rest }) => rest)(binding)],
    ["a string revision", { ...binding, expected_default_revision_id: "10" }],
    ["a short fingerprint", { ...binding, preimage_fingerprint: "c" }],
    ["an unsafe language", { ...binding, language: "de;" }],
    ["a non-boolean published", { ...binding, published: "false" }],
    ["an extra member", { ...binding, other: 1 }],
    ["a non-object", "binding"],
  ])("refuses %s before any call", async (_name, expectedBinding) => {
    expect(await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding }))).toMatch(/^invalid_binding: |Invalid|expected/i);
    expect(callDrupalMcp).not.toHaveBeenCalled();
    expect(listDrupalMcpToolNames).not.toHaveBeenCalled();
  });

  it("refuses a binding for another page", async () => {
    expect(await failure(call("drupal_node_update", { instanceId: "site", nodeId: "8", fields: { title: "New" }, expectedBinding: binding }))).toMatch(/^invalid_binding: .*another page or language/);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it.each<[string, string, Record<string, unknown>]>([
    ["drupal_node_update", "only empty values", { fields: { title: "" } }],
    ["drupal_node_update", "an empty field map", { fields: {} }],
    ["drupal_node_publish", "only empty values", { fields: { title: "" } }],
  ])("%s refuses %s with invalid_input on the bound path", async (tool, _name, extra) => {
    expect(await failure(call(tool as never, { instanceId: "site", nodeId: "7", expectedBinding: binding, ...extra }))).toMatch(/^invalid_input: /);
    expect(writes()).toHaveLength(0);
  });

  it.each(["drupal_node_update", "drupal_node_publish", "drupal_node_create_draft_revision"])("%s answers a denied write authority with permission_denied on the bound path", async (tool) => {
    authority.mockRejectedValue(new Error("not authorized"));
    const b = tool === "drupal_node_create_draft_revision" ? publishedBinding : binding;
    expect(await failure(call(tool as never, { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: b }))).toMatch(/^permission_denied: /);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it.each(["drupal_node_update", "drupal_node_publish"])("%s answers an unknown instance with invalid_input on the bound path", async (tool) => {
    expect(await failure(call(tool as never, { instanceId: "other", nodeId: "7", fields: { title: "New" }, expectedBinding: binding }))).toMatch(/^invalid_input: /);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("keeps the existing authority message without a binding", async () => {
    authority.mockRejectedValue(new Error("not authorized"));
    expect(await failure(call("drupal_node_publish", { instanceId: "site", nodeId: "7" }))).toBe("not authorized");
  });

  it("refuses publish on drupal_node_update: publishing goes through drupal_node_publish", async () => {
    await expect(call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: binding, publish: true })).rejects.toThrow();
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });
});

describe("drupal_node_publish with expectedBinding", () => {
  it("publishes through cinatra_publish_unpublished with exactly the binding's values", async () => {
    const result = await call("drupal_node_publish", { instanceId: "site", nodeId: "7", expectedBinding: binding });
    expect(toolsCalled()).toEqual([PUBLISH_UNPUBLISHED]);
    expect(calls()[0][2]).toEqual({ nid: 7, language: "de", expected_default_revision_id: 10, expected_latest_revision_id: 10, expected_changed: 1700000000, workflow_fingerprint: A, preimage_fingerprint: C });
    expect(result).toEqual({ nodeId: "7", nid: 7, language: "de", revision_id: 11, published: true, changed: 1700000100, applied: true, fields: {} });
  });

  it("writes the reviewed fields and publishes in one save through cinatra_write_unpublished", async () => {
    const result = await call("drupal_node_publish", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: binding });
    expect(toolsCalled()).toEqual([READER, WRITE_UNPUBLISHED]);
    expect(calls()[1][2]).toEqual({ nid: 7, language: "de", expected_default_revision_id: 10, expected_latest_revision_id: 10, expected_changed: 1700000000, workflow_fingerprint: A, preimage_fingerprint: C, updates: { title: [{ value: "New" }] }, publish: true });
    expect(result).toMatchObject({ published: true, revision_id: 11, fields: { title: [{ value: "New" }] } });
  });

  it("refuses without cinatra_publish_unpublished and never calls mcp_publish_content", async () => {
    vi.mocked(listDrupalMcpToolNames).mockResolvedValue([READER, DRAFT_WRITER, "mcp_publish_content"]);
    expect(await failure(call("drupal_node_publish", { instanceId: "site", nodeId: "7", expectedBinding: binding }))).toMatch(/^module_capability_missing: .*cinatra_publish_unpublished/);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("refuses fields without a binding", async () => {
    await expect(call("drupal_node_publish", { instanceId: "site", nodeId: "7", fields: { title: "New" } })).rejects.toThrow(/expectedBinding/);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("refuses a result that is not the published default revision as unverified", async () => {
    route({ writeResult: { is_published: false } });
    expect(await failure(call("drupal_node_publish", { instanceId: "site", nodeId: "7", expectedBinding: binding }))).toMatch(/^write_unverified: /);
  });
});

describe("drupal_node_create_draft_revision with expectedBinding", () => {
  const READ = "mcp_jsonapi_list_entities";
  function routeDraft(o: Route & { genericStatus?: boolean; readerThrows?: string } = {}) {
    route({ ...o, read: { ...publishedRead, preimage_fingerprint: "d".repeat(64), workflow_fingerprint: "b".repeat(64), ...o.read } });
    const inner = vi.mocked(callDrupalMcp).getMockImplementation()!;
    vi.mocked(callDrupalMcp).mockImplementation(async (i, tool, args) => {
      if (tool === READ) return { items: [{ entity_type: "node", id: 7, uuid: "uuid-7", bundle: "article", status: o.genericStatus ?? true, fields: { nid: 7, langcode: "de", title: "Old", body: "Old body" } }] };
      if (tool === READER && o.readerThrows !== undefined) throw new Error(o.readerThrows);
      return inner(i, tool, args);
    });
  }
  const draft = (extra: Record<string, unknown> = {}, b: EditBinding = publishedBinding) =>
    call("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: b, ...extra });

  // Every exit of the bound draft before its writer answers with a coded
  // refusal a flow can branch on, decided against the binding.
  it.each<[string, Parameters<typeof routeDraft>[0], EditBinding, string]>([
    ["a pending revision created after the read", { read: { latest_revision_id: 11 } }, publishedBinding, "node_changed"],
    ["a pending revision that already existed at the read", { read: { latest_revision_id: 11 } }, { ...publishedBinding, expected_latest_revision_id: 11 }, "pending_revision"],
    ["a module read that reports the page unpublished", { read: { is_published: false } }, publishedBinding, "node_changed"],
    ["a generic read that reports the page unpublished", { genericStatus: false }, publishedBinding, "node_changed"],
    ["content that changed between the connector's two reads", { secondRead: { preimage_fingerprint: "e".repeat(64) } }, publishedBinding, "node_changed"],
    ["an unmoderated page", { read: { moderated: false } }, publishedBinding, "refused"],
    ["a module reader refusal", { readerThrows: `Drupal ${READER} returned failure: The exact published preimage is not readable in this language.` }, publishedBinding, "refused"],
    ["a module reader permission refusal", { readerThrows: `Drupal ${READER} returned failure: The existing MCP content integration and its read/write permissions are required.` }, publishedBinding, "permission_denied"],
    ["an unreachable module reader", { readerThrows: "fetch failed: Secret page words" }, publishedBinding, "read_unavailable"],
  ])("refuses %s before the writer with a coded refusal", async (_name, o, b, code) => {
    routeDraft(o);
    const message = await failure(draft({}, b));
    expect(message.startsWith(`${code}: `)).toBe(true);
    expect(message).not.toContain("Secret page words");
    expect(writes()).toHaveLength(0);
  });

  it("refuses an earlier read's changed expectedFields with node_changed", async () => {
    routeDraft();
    expect(await failure(draft({ expectedFields: { title: "Other" } }))).toMatch(/^node_changed: /);
    expect(writes()).toHaveLength(0);
  });

  it("refuses a scalar edit of a multi-valued field with invalid_input", async () => {
    routeDraft({ fields: { ...before, title: [{ value: "A" }, { value: "B" }] } });
    expect(await failure(draft())).toMatch(/^invalid_input: /);
    expect(writes()).toHaveLength(0);
  });

  it.each<[string, Record<string, unknown>]>([["only empty values", { fields: { title: "" } }], ["a system field", { fields: { path: "/x" } }]])("refuses %s with invalid_input", async (_name, extra) => {
    routeDraft();
    expect(await failure(draft(extra))).toMatch(/^invalid_input: /);
    expect(writes()).toHaveLength(0);
  });

  it("keeps the existing message for a pending revision without a binding", async () => {
    routeDraft({ read: { latest_revision_id: 11 } });
    const message = await failure(call("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fields: { title: "New" } }));
    expect(message).toMatch(/^Protected draft unavailable: .*pending draft must be reviewed/);
  });

  it("passes the binding's values to the protected draft writer in place of the connector's own fresh read", async () => {
    routeDraft();
    await call("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: publishedBinding });
    const writer = calls().find((c) => c[1] === DRAFT_WRITER);
    expect(writer?.[2]).toEqual({
      nid: 7, language: "de", draft_state: "draft",
      expected_default_revision_id: 10, expected_latest_revision_id: 10, workflow_fingerprint: A, preimage_fingerprint: C,
      updates: { title: [{ value: "New" }] },
    });
    expect(toolsCalled().some((t) => ["mcp_update_content", "mcp_publish_content"].includes(t))).toBe(false);
  });

  it("maps the module's changed-page refusal to node_changed, not to an inspection request", async () => {
    routeDraft({ writeFailure: "The live page values changed; read them again before editing." });
    const message = await failure(call("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: publishedBinding }));
    expect(message).toMatch(/^node_changed: /);
    expect(message).not.toMatch(/read them again before editing/);
  });

  it("refuses a binding for an unpublished page", async () => {
    expect(await failure(call("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: binding }))).toMatch(/^wrong_page_state: /);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("refuses a language other than the binding's", async () => {
    expect(await failure(call("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", language: "en", fields: { title: "New" }, expectedBinding: publishedBinding }))).toMatch(/^invalid_binding: /);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("needs the module version with the bound writers", async () => {
    vi.mocked(listDrupalMcpToolNames).mockResolvedValue([READER, DRAFT_WRITER]);
    expect(await failure(call("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: publishedBinding }))).toMatch(/^module_capability_missing: /);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("keeps the inspection message for an unrecognized failure after dispatch", async () => {
    routeDraft({ writeThrows: "socket closed" });
    const message = await failure(call("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: publishedBinding }));
    expect(message).toMatch(/inspection required/i);
    expect(message).not.toMatch(/socket closed/);
  });
});

describe("JSON text arguments", () => {
  const SECRET = "Secret page words";
  it("accepts fieldsJson and expectedBindingJson as the object forms", async () => {
    await call("drupal_node_update", { instanceId: "site", nodeId: "7", fieldsJson: JSON.stringify({ title: "New" }), expectedBindingJson: JSON.stringify(binding) });
    expect(calls().find((c) => c[1] === WRITE_UNPUBLISHED)?.[2]).toMatchObject({ updates: { title: [{ value: "New" }] }, expected_changed: 1700000000 });
  });
  it("accepts expectedBindingJson on drupal_node_publish", async () => {
    await call("drupal_node_publish", { instanceId: "site", nodeId: "7", expectedBindingJson: JSON.stringify(binding) });
    expect(toolsCalled()).toEqual([PUBLISH_UNPUBLISHED]);
  });
  it("accepts fieldsJson and expectedBindingJson on the protected draft and writes those values", async () => {
    route({ read: publishedRead });
    vi.mocked(callDrupalMcp).mockImplementation(((inner) => async (i: never, tool: string, args: never) => tool === "mcp_jsonapi_list_entities"
      ? { items: [{ entity_type: "node", id: 7, uuid: "uuid-7", bundle: "article", status: true, fields: { nid: 7, langcode: "de", title: "Old" } }] }
      : inner(i, tool, args))(vi.mocked(callDrupalMcp).getMockImplementation()!) as never);
    await call("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fieldsJson: JSON.stringify({ body: "From text" }), expectedBindingJson: JSON.stringify(publishedBinding) });
    expect(calls().find((c) => c[1] === DRAFT_WRITER)?.[2]).toEqual({
      nid: 7, language: "de", draft_state: "draft",
      expected_default_revision_id: 10, expected_latest_revision_id: 10, workflow_fingerprint: A, preimage_fingerprint: C,
      updates: { body: [{ value: "From text", format: "basic_html", summary: "Keep" }] },
    });
  });
  it.each<[string, Record<string, unknown>, RegExp]>([
    ["fields and fieldsJson", { fields: { title: "a" }, fieldsJson: "{}" }, /^Give the field updates as fields or as fieldsJson, not both\.$/],
    ["expectedBinding and expectedBindingJson", { fields: { title: "a" }, expectedBinding: binding, expectedBindingJson: JSON.stringify(binding) }, /^Give the binding as expectedBinding or as expectedBindingJson, not both\.$/],
    ["text that is not JSON", { fieldsJson: `{${SECRET}` }, /^fieldsJson must be the text of a JSON object\.$/],
    ["a JSON array", { fieldsJson: JSON.stringify([SECRET]) }, /^fieldsJson must be the text of a JSON object\.$/],
    ["JSON null", { fieldsJson: "null" }, /^fieldsJson must be the text of a JSON object\.$/],
    ["a JSON number", { fieldsJson: "7" }, /^fieldsJson must be the text of a JSON object\.$/],
    ["a JSON string", { fieldsJson: JSON.stringify(SECRET) }, /^fieldsJson must be the text of a JSON object\.$/],
    ["a binding array", { fields: { title: "a" }, expectedBindingJson: JSON.stringify([SECRET]) }, /^expectedBindingJson must be the text of a JSON object\.$/],
  ])("refuses %s with a fixed message that never echoes the text", async (_name, extra, expected) => {
    const message = await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", ...extra }));
    expect(message).toMatch(expected);
    expect(message).not.toContain(SECRET);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });
  it("bounds the JSON text at 256 KiB counted in UTF-8 bytes", async () => {
    const atLimit = JSON.stringify({ title: "x".repeat(JSON_ARGUMENT_MAX_BYTES - 12) });
    expect(new TextEncoder().encode(atLimit).length).toBe(JSON_ARGUMENT_MAX_BYTES);
    await call("drupal_node_update", { instanceId: "site", nodeId: "7", fieldsJson: atLimit, expectedBinding: binding });
    vi.mocked(callDrupalMcp).mockClear();
    // Each "é" is one UTF-16 unit but two UTF-8 bytes.
    const multiByte = JSON.stringify({ title: "é".repeat(JSON_ARGUMENT_MAX_BYTES / 2) });
    expect(multiByte.length).toBeLessThan(JSON_ARGUMENT_MAX_BYTES);
    expect(await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fieldsJson: multiByte, expectedBinding: binding }))).toBe(`fieldsJson is larger than ${JSON_ARGUMENT_MAX_BYTES} bytes.`);
    expect(await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "a" }, expectedBindingJson: " ".repeat(JSON_ARGUMENT_MAX_BYTES + 1) }))).toBe(`expectedBindingJson is larger than ${JSON_ARGUMENT_MAX_BYTES} bytes.`);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });
});

describe("refusal mapping", () => {
  it.each<[string, string]>([
    ["The page revision changed; read it again before editing.", "node_changed"],
    ["The workflow configuration changed; read it again before editing.", "node_changed"],
    ["The page values changed; read them again before editing.", "node_changed"],
    ["The page was saved after it was read; read it again before editing.", "node_changed"],
    ["This page is published; edit it through the protected draft instead.", "node_changed"],
    ["The stored result is not the requested revision; the write was rolled back.", "refused"],
    ["A newer revision than the current one exists; review it first.", "node_changed"],
    ["Editing this page is not permitted.", "permission_denied"],
    ["Publishing this page is not permitted.", "permission_denied"],
    ["Changing the workflow state of this page is not permitted.", "permission_denied"],
    ["A requested field cannot be edited in this translation.", "permission_denied"],
    ["The existing MCP content integration and its read/write permissions are required.", "permission_denied"],
    ["A complete language-bound revision, changed time, workflow and content binding is required.", "invalid_input"],
    ["A requested field does not exist on this page.", "invalid_input"],
    ["The stored value differs from the reviewed value; nothing was written.", "invalid_input"],
    ["The page workflow does not allow publishing it.", "refused"],
    ["The page revision could not be verified; inspect it before retrying.", "write_unverified"],
    ["Some future refusal text naming Secret page words", "refused"],
  ])("maps %j to %s and never repeats the site's text", async (text, code) => {
    route({ writeFailure: text });
    const message = await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: binding }));
    expect(message.startsWith(`${code}: `)).toBe(true);
    expect(message).not.toContain(text);
  });

  it("maps a pending revision that already existed at the read to pending_revision", async () => {
    route({ writeFailure: "A newer revision than the current one exists; review it first." });
    const message = await failure(call("drupal_node_publish", { instanceId: "site", nodeId: "7", expectedBinding: { ...binding, expected_latest_revision_id: 12 } }));
    expect(message).toMatch(/^pending_revision: /);
  });

  it("maps a failure that is not a module refusal to write_unverified", async () => {
    route({ writeThrows: "fetch failed: Secret page words" });
    const message = await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: binding }));
    expect(message).toMatch(/^write_unverified: /);
    expect(message).not.toContain("Secret page words");
  });
});

describe("without expectedBinding every path is unchanged", () => {
  const generic = { entity_type: "node", id: 7, uuid: "uuid-7", bundle: "article", status: false, fields: { nid: 7, langcode: "de", title: "Old" } };
  beforeEach(() => {
    vi.mocked(callDrupalMcp).mockImplementation(async (_i, tool) => {
      if (tool === "mcp_jsonapi_list_entities") return { items: [generic] };
      return { ok: true };
    });
  });
  it("drupal_node_update still reads the status and calls mcp_update_content, without a tool list", async () => {
    await call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" } });
    expect(toolsCalled()).toEqual(["mcp_jsonapi_list_entities", "mcp_update_content"]);
    expect(calls()[1][2]).toEqual({ nid: "7", updates: { title: "New" } });
    expect(listDrupalMcpToolNames).not.toHaveBeenCalled();
  });
  it("drupal_node_update takes fieldsJson on the same road", async () => {
    await call("drupal_node_update", { instanceId: "site", nodeId: "7", fieldsJson: JSON.stringify({ title: "New" }) });
    expect(calls()[1][2]).toEqual({ nid: "7", updates: { title: "New" } });
  });
  it("drupal_node_publish still calls mcp_publish_content", async () => {
    await call("drupal_node_publish", { instanceId: "site", nodeId: "7" });
    expect(toolsCalled()).toEqual(["mcp_publish_content"]);
    expect(calls()[0][2]).toEqual({ nid: "7", publish: true });
    expect(listDrupalMcpToolNames).not.toHaveBeenCalled();
  });
  it("drupal_node_update refuses a call without fields as before", async () => {
    await expect(call("drupal_node_update", { instanceId: "site", nodeId: "7" })).rejects.toThrow();
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });
});

// Through the registration: the real MCP server validates each call against
// the registered input schema (dropping undeclared keys) before the handler
// runs, so these cases go through tools/call, not the handler directly.
describe("through the registered MCP server", () => {
  async function toolsCall(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const srv = new McpServer({ name: "drupal-mcp-connector-test", version: "0.0.0" });
    registerDrupalPrimitives({ registerTool: (n: string, c: unknown, h: unknown) => (srv.registerTool as (...a: unknown[]) => unknown)(n, c, h) } as never);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await srv.connect(transport);
    try {
      const res = await transport.handleRequest(new Request("https://cinatra.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }));
      const body = await res.json() as { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message?: string } };
      if (body.error) return { isError: true, text: body.error.message ?? "" };
      return { isError: body.result?.isError === true, text: body.result?.content?.[0]?.text ?? "" };
    } finally {
      await transport.close();
    }
  }

  it("refuses publish: true on a bound drupal_node_update with a coded refusal and writes nothing", async () => {
    const result = await toolsCall("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: binding, publish: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/invalid_input: .*drupal_node_publish/);
    expect(writes()).toHaveLength(0);
  });

  it("refuses publish: true on an unbound drupal_node_update and writes nothing", async () => {
    const result = await toolsCall("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, publish: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/invalid_input: /);
    expect(writes()).toHaveLength(0);
  });

  it("lets publish: false through as an ordinary bound update", async () => {
    const result = await toolsCall("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: binding, publish: false });
    expect(result.isError).toBe(false);
    expect(calls().find((c) => c[1] === WRITE_UNPUBLISHED)?.[2]).not.toHaveProperty("publish");
  });

  it.each(["drupal_node_update", "drupal_node_create_draft_revision"])("%s refuses a bound call without fields with invalid_input", async (tool) => {
    const b = tool === "drupal_node_create_draft_revision" ? publishedBinding : binding;
    const result = await toolsCall(tool, { instanceId: "site", nodeId: "7", expectedBinding: b });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^invalid_input: /);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("keeps a bound drupal_node_publish without fields as the publish-only call", async () => {
    const result = await toolsCall("drupal_node_publish", { instanceId: "site", nodeId: "7", expectedBinding: binding });
    expect(result.isError).toBe(false);
    expect(toolsCalled()).toEqual([PUBLISH_UNPUBLISHED]);
  });

  it("keeps the existing message for an unbound drupal_node_update without fields", async () => {
    const result = await toolsCall("drupal_node_update", { instanceId: "site", nodeId: "7" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("No fields provided.");
  });
});
