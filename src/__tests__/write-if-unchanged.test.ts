// cinatra#3745 (owner decision 1234 A): an agent's Drupal page edit reads the
// page and writes the reviewed change through flow steps without a model, and
// each write happens only if the page is unchanged since the read the review
// was based on. The read tool returns the module's binding; the write tools
// pass that binding to the Cinatra module's own tools, which compare it again
// under the node lock. Without a binding every write tool behaves as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
vi.mock("../lib/drupal-mcp-client", () => ({ callDrupalMcp: vi.fn(), listDrupalMcpToolNames: vi.fn() }));
// Pass-through spies, so a test can inject an arbitrary throw at one stage of
// a bound write (before any call, between read and write, after the write).
vi.mock("../integration/edit-binding", async (importOriginal) => {
  const real = await importOriginal<typeof import("../integration/edit-binding")>();
  return { ...real, checkEditBinding: vi.fn(real.checkEditBinding), moduleBindingArgs: vi.fn(real.moduleBindingArgs), verifyUnpublishedWrite: vi.fn(real.verifyUnpublishedWrite) };
});
import { callDrupalMcp, listDrupalMcpToolNames } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers, nodeUpdateSchema, nodePublishSchema, nodeCreateDraftSchema } from "../mcp/handlers";
import { z } from "zod";
import { registerDrupalPrimitives } from "../mcp/registry";
import { registerDrupalConnector } from "../deps";
import { buildDrupalInstanceClient } from "../lib/drupal-instances";
import { MODULE_READ_REVISION as READER, MODULE_WRITE_DRAFT as DRAFT_WRITER, PROTECTED_DRAFT_CONTRACT, type StoredFieldItems } from "../integration/module-protected-draft";
import {
  MODULE_WRITE_UNPUBLISHED as WRITE_UNPUBLISHED, MODULE_PUBLISH_UNPUBLISHED as PUBLISH_UNPUBLISHED,
  JSON_ARGUMENT_MAX_BYTES, checkEditBinding, moduleBindingArgs, verifyUnpublishedWrite, type EditBinding,
} from "../integration/edit-binding";

const instance = { id: "site", name: "Site", siteUrl: "https://Example.test/", nangoConnectionId: "site", providerConfigKey: "drupal", createdAt: "", updatedAt: "2026-11-01T00:00:00.000Z" };
const A = "a".repeat(64);
const C = "c".repeat(64);
const before: StoredFieldItems = { title: [{ value: "Old" }], body: [{ value: "Old body", format: "basic_html", summary: "Keep" }] };
const unpublishedRead = { node_id: 7, uuid: "uuid-7", language: "de", default_revision_id: 10, latest_revision_id: 10, is_default_revision: true, is_published: false, changed: 1700000000, moderated: false, canonical_moderation_field: false, workflow_fingerprint: A, preimage_fingerprint: C, draft_states: {}, allowed_draft_states: [], available_fields: ["body", "title"] };
const publishedRead = { ...unpublishedRead, is_published: true, moderated: true, canonical_moderation_field: true, draft_states: { draft: { published: false, default_revision: false } }, allowed_draft_states: ["draft"] };
const binding: EditBinding = { instanceId: "site", target: "https://example.test", targetUpdatedAt: "2026-11-01T00:00:00.000Z", nid: 7, language: "de", published: false, expected_default_revision_id: 10, expected_latest_revision_id: 10, expected_changed: 1700000000, workflow_fingerprint: A, preimage_fingerprint: C };
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
    // The read gates on the site's tool list (the module reader) once.
    expect(listDrupalMcpToolNames).toHaveBeenCalledTimes(1);
    expect(authority).not.toHaveBeenCalled();
    expect(result).toEqual({
      instanceId: "site", nodeId: "7", nid: 7, uuid: "uuid-7", language: "de", published: false,
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
    ["no instance", (({ instanceId: _i, ...rest }) => rest)(binding)],
    ["no target", (({ target: _t, ...rest }) => rest)(binding)],
    ["a target that is not a normalised base URL", { ...binding, target: "https://example.test/" }],
    ["a target with credentials", { ...binding, target: "https://user:secret@example.test" }],
    ["an empty target stamp", { ...binding, targetUpdatedAt: "" }],
    ["an empty instance", { ...binding, instanceId: "" }],
    ["a non-object", "binding"],
  ])("refuses %s before any call", async (_name, expectedBinding) => {
    expect(await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding }))).toMatch(/^invalid_binding: |Invalid|expected/i);
    expect(callDrupalMcp).not.toHaveBeenCalled();
    expect(listDrupalMcpToolNames).not.toHaveBeenCalled();
  });

  it("refuses a binding for another page", async () => {
    expect(await failure(call("drupal_node_update", { instanceId: "site", nodeId: "8", fields: { title: "New" }, expectedBinding: binding }))).toMatch(/^invalid_binding: .*another Drupal instance, page or language/);
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
    expect(await failure(call(tool as never, { instanceId: "other", nodeId: "7", fields: { title: "New" }, expectedBinding: { ...binding, instanceId: "other" } }))).toMatch(/^invalid_input: /);
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
    expect(message).toMatch(/^write_unverified: .*inspection required/i);
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
    ["expectedBinding and expectedBindingJson", { fields: { title: "a" }, expectedBinding: binding, expectedBindingJson: JSON.stringify(binding) }, /^invalid_binding: Give the binding as expectedBinding or as expectedBindingJson, not both\.$/],
    ["text that is not JSON", { fieldsJson: `{${SECRET}` }, /^fieldsJson must be the text of a JSON object\.$/],
    ["a JSON array", { fieldsJson: JSON.stringify([SECRET]) }, /^fieldsJson must be the text of a JSON object\.$/],
    ["JSON null", { fieldsJson: "null" }, /^fieldsJson must be the text of a JSON object\.$/],
    ["a JSON number", { fieldsJson: "7" }, /^fieldsJson must be the text of a JSON object\.$/],
    ["a JSON string", { fieldsJson: JSON.stringify(SECRET) }, /^fieldsJson must be the text of a JSON object\.$/],
    ["a binding array", { fields: { title: "a" }, expectedBindingJson: JSON.stringify([SECRET]) }, /^invalid_binding: expectedBindingJson must be the text of a JSON object\.$/],
    ["bound text that is not JSON", { fieldsJson: `{${SECRET}`, expectedBinding: binding }, /^invalid_input: fieldsJson must be the text of a JSON object\.$/],
    ["bound fields and fieldsJson", { fields: { title: "a" }, fieldsJson: "{}", expectedBinding: binding }, /^invalid_input: Give the field updates as fields or as fieldsJson, not both\.$/],
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
    expect(await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fieldsJson: multiByte, expectedBinding: binding }))).toBe(`invalid_input: fieldsJson is larger than ${JSON_ARGUMENT_MAX_BYTES} bytes.`);
    expect(await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "a" }, expectedBindingJson: " ".repeat(JSON_ARGUMENT_MAX_BYTES + 1) }))).toBe(`invalid_binding: expectedBindingJson is larger than ${JSON_ARGUMENT_MAX_BYTES} bytes.`);
    expect(await failure(call("drupal_node_update", { instanceId: "site", nodeId: "7", fieldsJson: multiByte }))).toBe(`fieldsJson is larger than ${JSON_ARGUMENT_MAX_BYTES} bytes.`);
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
  async function toolsList(): Promise<{ name: string; inputSchema: Record<string, unknown> }[]> {
    const srv = new McpServer({ name: "drupal-mcp-connector-test", version: "0.0.0" });
    registerDrupalPrimitives({ registerTool: (n: string, c: unknown, h: unknown) => (srv.registerTool as (...a: unknown[]) => unknown)(n, c, h) } as never);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await srv.connect(transport);
    try {
      const res = await transport.handleRequest(new Request("https://cinatra.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }));
      return ((await res.json()) as { result: { tools: { name: string; inputSchema: Record<string, unknown> }[] } }).result.tools;
    } finally {
      await transport.close();
    }
  }

  it.each<[string, z.ZodTypeAny]>([["drupal_node_update", nodeUpdateSchema], ["drupal_node_publish", nodePublishSchema], ["drupal_node_create_draft_revision", nodeCreateDraftSchema]])(
    "%s publishes exactly its real input schema on tools/list", async (name, schema) => {
      const published = (await toolsList()).find((t) => t.name === name)?.inputSchema ?? {};
      const { $schema: _a, ...actual } = published;
      const { $schema: _b, ...expected } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
      expect(actual).toEqual(expected);
    });

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

  it.each(["drupal_node_update", "drupal_node_publish", "drupal_node_create_draft_revision"])("%s refuses a binding whose instance is not the call's before any call (a mix-up, not a forgery)", async (tool) => {
    const b = tool === "drupal_node_create_draft_revision" ? publishedBinding : binding;
    const result = await toolsCall(tool, { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: { ...b, instanceId: "clone" } });
    expect(result.text).toMatch(/^invalid_binding: /);
    expect(callDrupalMcp).not.toHaveBeenCalled();
    expect(listDrupalMcpToolNames).not.toHaveBeenCalled();
    expect(authority).not.toHaveBeenCalled();
  });

  // The connector members are consistency checks, not authentication: a caller
  // who rewrites them CONSISTENTLY to another instance it may write (values
  // drupal_instances_list shows) passes the connector's checks, and the write
  // goes to that instance under the caller's own write authority there. Only
  // the module's comparison of the page values stands between it and a save.
  it("accepts a binding rewritten consistently to another instance the caller may write: no authentication", async () => {
    const clone = { ...instance, id: "clone", name: "Clone", siteUrl: "https://clone.example.test", nangoConnectionId: "clone", updatedAt: "2026-11-03T00:00:00.000Z" };
    registerDrupalConnector({ decodeCursor: () => 0, buildListPage: (items, total) => ({ items, total }), dispatchContentEditor: async () => "{}", buildNangoBearerHeader: async () => ({ Authorization: "Bearer unit" }), listMcpInstances: () => [instance, clone], probeMcp: async () => "registered", resolveMcpServerUrl: (u) => u, isPrivateUrl: () => false, isNangoConfigured: () => true, getApiStatus: async () => ({ instanceCount: 2, instances: [] }), saveInstance: vi.fn(), deleteInstance: vi.fn(), listInstanceStatuses: async () => [], requireInstanceWriteAuthority: authority });
    try {
      const listed = (JSON.parse((await toolsCall("drupal_instances_list", {})).text) as { id: string; siteUrl: string; updatedAt: string }[]).find((i) => i.id === "clone");
      expect(listed).toBeDefined();
      const forged = { ...binding, instanceId: listed!.id, target: listed!.siteUrl, targetUpdatedAt: listed!.updatedAt };
      const result = await toolsCall("drupal_node_update", { instanceId: "clone", nodeId: "7", fields: { title: "New" }, expectedBinding: forged });
      expect(result.isError).toBe(false);
      expect(authority).toHaveBeenCalledWith({ instanceId: "clone", primitiveName: "drupal_node_update" });
      const write = calls().find((c) => c[1] === WRITE_UNPUBLISHED);
      expect((write?.[0] as { id: string }).id).toBe("clone");
    } finally {
      deps();
    }
  });

  it("returns the instance in the binding and at the top level of the read", async () => {
    const result = await toolsCall("drupal_node_read_for_edit", { instanceId: "site", nid: "7" });
    const read = JSON.parse(result.text) as { instanceId: string; binding: EditBinding };
    expect(read.instanceId).toBe("site");
    expect(read.binding.instanceId).toBe("site");
  });

  it("never sends the connector's instance or target to the module", async () => {
    await toolsCall("drupal_node_publish", { instanceId: "site", nodeId: "7", expectedBinding: binding });
    for (const key of ["instanceId", "target", "targetUpdatedAt", "published"]) expect(calls()[0][2]).not.toHaveProperty(key);
  });

  it("returns the normalised site target and the row stamp in the read's binding", async () => {
    const read = JSON.parse((await toolsCall("drupal_node_read_for_edit", { instanceId: "site", nid: "7" })).text) as { binding: EditBinding };
    expect(read.binding.target).toBe("https://example.test");
    expect(read.binding.targetUpdatedAt).toBe("2026-11-01T00:00:00.000Z");
  });

  describe("a legacy instance row with no stored updatedAt, served by the real instance reader", () => {
    let stored: Record<string, unknown>;
    beforeEach(() => {
      stored = { id: "site", name: "Site", siteUrl: "https://Example.test/", nangoConnectionId: "site", providerConfigKey: "drupal" };
      const client = buildDrupalInstanceClient({
        connectorConfig: () => ({ read: <T,>() => ({ instances: [stored] }) as T, write: () => {} }),
        nango: () => ({ providerConfigKeys: { drupal: "drupal" } }),
        connectionGate: () => ({}),
        warn: () => {},
      } as never);
      registerDrupalConnector({ decodeCursor: () => 0, buildListPage: (items, total) => ({ items, total }), dispatchContentEditor: async () => "{}", buildNangoBearerHeader: async () => ({ Authorization: "Bearer unit" }), listMcpInstances: () => client.getDrupalAPISettings().instances, probeMcp: async () => "registered", resolveMcpServerUrl: (u) => u, isPrivateUrl: () => false, isNangoConfigured: () => true, getApiStatus: async () => ({ instanceCount: 1, instances: [] }), saveInstance: vi.fn(), deleteInstance: vi.fn(), listInstanceStatuses: async () => [], requireInstanceWriteAuthority: authority });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-25T08:00:00.000Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
      deps();
    });

    async function readBinding(): Promise<EditBinding> {
      return (JSON.parse((await toolsCall("drupal_node_read_for_edit", { instanceId: "site", nid: "7" })).text) as { binding: EditBinding }).binding;
    }

    it("records no made-up stamp and writes after the clock moved", async () => {
      const read = await readBinding();
      expect(read.targetUpdatedAt).toBeNull();
      vi.setSystemTime(new Date("2026-11-25T09:30:00.000Z"));
      route();
      const result = await toolsCall("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: read });
      expect(result.isError).toBe(false);
      expect(writes()).toHaveLength(1);
    });

    it("refuses when the legacy row was saved (and got a real stamp) between the read and the write", async () => {
      const read = await readBinding();
      stored.updatedAt = "2026-11-25T08:10:00.000Z";
      vi.mocked(callDrupalMcp).mockClear();
      const result = await toolsCall("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: read });
      expect(result.text).toMatch(/^invalid_binding: .*reconfigured/);
      expect(callDrupalMcp).not.toHaveBeenCalled();
    });
  });

  it.each<[string, Partial<typeof instance>]>([
    ["another site URL", { siteUrl: "https://clone.example.test" }],
    ["another base path", { siteUrl: "https://example.test/clone" }],
    ["a newer row stamp", { updatedAt: "2026-11-02T00:00:00.000Z" }],
  ])("refuses a binding whose instance id now points at %s before any site call", async (_name, change) => {
    for (const tool of ["drupal_node_update", "drupal_node_publish", "drupal_node_create_draft_revision"]) {
      vi.mocked(callDrupalMcp).mockClear();
      vi.mocked(listDrupalMcpToolNames).mockClear();
      Object.assign(instance, change);
      try {
        const b = tool === "drupal_node_create_draft_revision" ? publishedBinding : binding;
        const result = await toolsCall(tool, { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: b });
        expect(result.text).toMatch(/^invalid_binding: .*reconfigured/);
      } finally {
        Object.assign(instance, { siteUrl: "https://Example.test/", updatedAt: "2026-11-01T00:00:00.000Z" });
      }
      expect(callDrupalMcp).not.toHaveBeenCalled();
      expect(listDrupalMcpToolNames).not.toHaveBeenCalled();
    }
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["drupal_node_create_draft_revision", { fields: { title: "New" }, expectedBinding: publishedBinding }, READER],
    ["drupal_node_update", { fields: { title: "New" }, expectedBinding: binding }, READER],
    ["drupal_node_publish", { fields: { title: "New" }, expectedBinding: binding }, READER],
    ["drupal_node_publish", { expectedBinding: binding }, PUBLISH_UNPUBLISHED],
    ["drupal_node_create_draft_revision", { fields: { title: "New" }, expectedBinding: publishedBinding }, DRAFT_WRITER],
  ])("%s refuses a site without a module tool its path calls (%#), naming it, before any call", async (tool, extra, missing) => {
    vi.mocked(listDrupalMcpToolNames).mockResolvedValue(ALL_TOOLS.filter((t) => t !== missing));
    const result = await toolsCall(tool, { instanceId: "site", nodeId: "7", ...extra });
    expect(result.text).toMatch(new RegExp(`^module_capability_missing: .*${missing}`));
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("drupal_node_read_for_edit refuses a site without the module reader, naming it, before any call", async () => {
    vi.mocked(listDrupalMcpToolNames).mockResolvedValue(ALL_TOOLS.filter((t) => t !== READER));
    const result = await toolsCall("drupal_node_read_for_edit", { instanceId: "site", nid: "7" });
    expect(result.text).toMatch(new RegExp(`^module_capability_missing: .*${READER}`));
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["malformed fieldsJson", { fieldsJson: "{not json" }, "invalid_input"],
    ["oversized fieldsJson", { fieldsJson: JSON.stringify({ title: "x".repeat(JSON_ARGUMENT_MAX_BYTES) }) }, "invalid_input"],
    ["a non-string fieldsJson", { fieldsJson: 7 }, "invalid_input"],
    ["a non-object expectedBinding", { fields: { title: "a" }, expectedBinding: "x" }, "invalid_binding"],
  ])("codes %s on a bound call through the server", async (_name, extra, code) => {
    const result = await toolsCall("drupal_node_update", { instanceId: "site", nodeId: "7", expectedBinding: binding, ...extra });
    expect(result.isError).toBe(true);
    expect(result.text.startsWith(`${code}: `)).toBe(true);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("codes an unknown key on a bound protected draft and still refuses it without a binding", async () => {
    const bound = await toolsCall("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: publishedBinding, status: 1 });
    expect(bound.text).toMatch(/^invalid_input: /);
    const unbound = await toolsCall("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fields: { title: "New" }, status: 1 });
    expect(unbound.isError).toBe(true);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  // The one wrapper: an arbitrary throw at each stage leaves as a coded refusal.
  it.each<[string, () => void, string, number]>([
    ["before any call", () => vi.mocked(checkEditBinding).mockImplementationOnce(() => { throw new TypeError("arbitrary Secret page words"); }), "invalid_input", 0],
    ["between the read and the write", () => vi.mocked(moduleBindingArgs).mockImplementationOnce(() => { throw new TypeError("arbitrary Secret page words"); }), "refused", 0],
    ["after the write call was sent", () => vi.mocked(verifyUnpublishedWrite).mockImplementationOnce(() => { throw new TypeError("arbitrary Secret page words"); }), "write_unverified", 1],
  ])("codes an arbitrary throw %s", async (_stage, inject, code, writesSent) => {
    inject();
    const result = await toolsCall("drupal_node_update", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: binding });
    expect(result.isError).toBe(true);
    expect(result.text.startsWith(`${code}: `)).toBe(true);
    expect(result.text).not.toContain("Secret page words");
    expect(calls().filter((c) => c[1] === WRITE_UNPUBLISHED)).toHaveLength(writesSent);
  });

  it("codes an arbitrary throw after the protected draft's write call was sent", async () => {
    vi.mocked(callDrupalMcp).mockImplementation(async (_i, tool, raw) => {
      const args = raw as Record<string, unknown>;
      if (tool === "mcp_jsonapi_list_entities") return { items: [{ entity_type: "node", id: 7, uuid: "uuid-7", bundle: "article", status: true, fields: { nid: 7, langcode: "de", title: "Old" } }] };
      if (tool === READER) return envelope({ ...publishedRead, fields: Object.fromEntries((args.fields as string[]).map((n) => [n, before[n]])) });
      if (tool === DRAFT_WRITER) throw new TypeError("arbitrary Secret page words");
      throw new Error(`Unexpected tool: ${tool}`);
    });
    const result = await toolsCall("drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fields: { title: "New" }, expectedBinding: publishedBinding });
    expect(result.text).toMatch(/^write_unverified: .*inspection required/i);
    expect(result.text).not.toContain("Secret page words");
  });

  // The texts origin/main returns for these unbound calls through the
  // registered server (its schema validation), unchanged.
  it.each<[string, Record<string, unknown>, string]>([
    ["drupal_node_update", { instanceId: "site", nodeId: "7" }, "Input validation error: Invalid arguments for tool drupal_node_update: fields: Invalid input: expected record, received undefined"],
    ["drupal_node_update", { instanceId: "site", nodeId: 7, fields: { title: "a" } }, "Input validation error: Invalid arguments for tool drupal_node_update: nodeId: Invalid input: expected string, received number"],
    ["drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7" }, "Input validation error: Invalid arguments for tool drupal_node_create_draft_revision: fields: Invalid input: expected record, received undefined"],
    ["drupal_node_create_draft_revision", { instanceId: "site", nodeId: "7", fields: { title: "a" }, status: 1 }, 'Input validation error: Invalid arguments for tool drupal_node_create_draft_revision: Unrecognized key: "status"'],
  ])("keeps origin/main's server validation text for an unbound %s call (%#)", async (tool, args, text) => {
    const result = await toolsCall(tool, args);
    expect(result.isError).toBe(true);
    expect(result.text).toBe(text);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });
});
