import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/drupal-mcp-client", () => ({ callDrupalMcp: vi.fn() }));
import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers, nodeCreateDraftSchema } from "../mcp/handlers";
import { registerDrupalConnector } from "../deps";
import { MODULE_READ_REVISION as READER, MODULE_WRITE_DRAFT as WRITER, PROTECTED_DRAFT_CONTRACT, type StoredFieldItems } from "../integration/module-protected-draft";
const READ = "mcp_jsonapi_list_entities";
const instance = { id: "site", name: "Site", siteUrl: "https://example.test", nangoConnectionId: "site", providerConfigKey: "drupal", createdAt: "", updatedAt: "" };
const node = { entity_type: "node", id: 7, uuid: "uuid-7", bundle: "article", status: true, fields: { nid: 7, vid: 10, langcode: "de", title: "Old", body: "Old body" } };
const before: StoredFieldItems = { title: [{ value: "Old" }], body: [{ value: "Old body", format: "basic_html", summary: "Keep" }], field_deck: [{ value: "Deck" }] };
const preimage = { node_id: 7, uuid: "uuid-7", language: "de", default_revision_id: 10, latest_revision_id: 10, is_default_revision: true, is_published: true, moderated: true, canonical_moderation_field: true, workflow_fingerprint: "a".repeat(64), preimage_fingerprint: "c".repeat(64), draft_states: { working: { published: false, default_revision: false } }, allowed_draft_states: ["working"], available_fields: Object.keys(before) };
const stored = { node_id: 7, uuid: "uuid-7", language: "de", revision_id: 11, default_revision_id: 10, is_default_revision: false, is_published: false, moderation_state: "working" };
const envelope = (result: unknown) => ({ contract: PROTECTED_DRAFT_CONTRACT, result });
const authority = vi.fn(async () => {});
function deps() { registerDrupalConnector({ decodeCursor: () => 0, buildListPage: (items, total) => ({ items, total }), dispatchContentEditor: async () => "{}", buildNangoBearerHeader: async () => ({ Authorization: "Bearer unit" }), listMcpInstances: () => [instance], probeMcp: async () => "registered", resolveMcpServerUrl: (s) => s, isPrivateUrl: () => false, isNangoConfigured: () => true, getApiStatus: async () => ({ instanceCount: 1, instances: [] }), saveInstance: vi.fn(), deleteInstance: vi.fn(), listInstanceStatuses: async () => [], requireInstanceWriteAuthority: authority }); }
type Overrides = { node?: unknown; preimage?: Record<string, unknown>; second?: Record<string, unknown>; writer?: Record<string, unknown>; reader?: Record<string, unknown>; missingContract?: boolean; readError?: boolean; writeError?: boolean; exactError?: boolean; sourceFields?: StoredFieldItems; storedFields?: StoredFieldItems; exactFields?: StoredFieldItems };
function route(o: Overrides = {}) { let reads = 0; const source = o.sourceFields ?? before; let saved = structuredClone(source); vi.mocked(callDrupalMcp).mockImplementation(async (_instance, tool, raw) => {
  const args = raw as Record<string, unknown>;
  if (tool === READ) return { items: [o.node ?? node] };
  if (tool === READER) { const names = args.fields as string[];
    if (args.revision_id !== undefined) { if (o.exactError) throw new Error("private provider detail"); const values = o.exactFields ?? saved; return envelope({ ...stored, fields: Object.fromEntries(names.map((key) => [key, values[key]])), ...o.reader }); }
    if (o.readError) throw new Error("permission denied"); const result = { ...preimage, available_fields: Object.keys(source), fields: Object.fromEntries(names.map((key) => [key, source[key]])), ...o.preimage, ...(reads++ ? o.second : {}) }; return o.missingContract ? { result } : envelope(result);
  }
  if (tool === WRITER) { if (o.writeError) throw new Error("private provider detail"); const updates = args.updates as StoredFieldItems; saved = { ...saved, ...updates, ...o.storedFields }; return envelope({ ...stored, fields: Object.fromEntries(Object.keys(updates).map((key) => [key, saved[key]])), ...o.writer }); }
  throw new Error(`Unexpected generic tool: ${tool}`);
}); }
const writes = () => vi.mocked(callDrupalMcp).mock.calls.filter((c) => [WRITER, "mcp_create_content", "mcp_update_content", "mcp_publish_content", "mcp_moderation_set_state"].includes(c[1]));
const request = (fields: Record<string, unknown> = { title: "Changed" }, language?: string) => ({ input: { instanceId: "site", nodeId: "7", fields, ...(language ? { language } : {}) } }) as never;
beforeEach(() => { vi.clearAllMocks(); authority.mockResolvedValue(undefined); deps(); route(); });
describe("module tools protect the complete published-node handler", () => {
  it("supports an explicit translation", () => { expect(nodeCreateDraftSchema.parse({ instanceId: "site", nodeId: "7", language: "de", fields: { title: "Changed" } })).toMatchObject({ language: "de" }); });
  it("rejects obsolete new-node requests and all-empty edits without stray content", async () => {
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision({ input: { instanceId: "site", nodeBundle: "article", title: "New node" } } as never)).rejects.toThrow();
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request({ title: "", body: "" }))).rejects.toThrow(/changed fields/i);
    expect(writes()).toHaveLength(0);
  });
  it("a failed current-node read cannot authorize a published or generic write", async () => {
    vi.mocked(callDrupalMcp).mockRejectedValue(new Error("read unavailable"));
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request())).rejects.toThrow(/published.*identity/i);
    await expect(createDrupalPrimitiveHandlers().drupal_node_update(request())).rejects.toThrow(/current.*status/i);
    expect(writes()).toHaveLength(0);
  });
  it("does not round a numeric node identity outside the safe integer range", async () => {
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision({ input: { instanceId: "site", nodeId: "9007199254740993", fields: { title: "Changed" } } } as never)).rejects.toThrow(/identity/i);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });
  it("writes once and independently reads the exact returned revision with complete stored fields", async () => {
    const result = await createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request()); expect(writes()).toHaveLength(1);
    expect(writes()[0]).toEqual([instance, WRITER, { nid: 7, language: "de", draft_state: "working", expected_default_revision_id: 10, expected_latest_revision_id: 10, workflow_fingerprint: "a".repeat(64), preimage_fingerprint: "c".repeat(64), updates: { title: [{ value: "Changed" }] } }]);
    const calls = vi.mocked(callDrupalMcp).mock.calls; expect(calls.map((c) => c[1])).toEqual([READ, READER, READER, WRITER, READER]); expect(calls.at(-1)?.[2]).toEqual({ nid: 7, language: "de", revision_id: 11, fields: ["body", "field_deck", "title"] });
    expect(result).toMatchObject({ nodeId: "7", revision_id: 11, pendingDraft: { nodeId: "7", revisionId: 11, language: "de", fields: { title: [{ value: "Changed" }], body: before.body } } });
  });
  it("returns stored normalized values, not requested echoes", async () => { route({ storedFields: { title: [{ value: "Normalized" }] } }); expect(await createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request())).toMatchObject({ pendingDraft: { fields: { title: [{ value: "Normalized" }] } } }); });
  it("returns the bound actual module before-fields for a truthful saved diff", async () => {
    const actual = { ...before, title: [{ value: "More recent live title" }] }; route({ sourceFields: actual });
    expect(await createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request())).toMatchObject({ pendingDraft: { beforeFields: actual, fields: { title: [{ value: "Changed" }] } } });
  });
  it("refuses stale earlier requested-field values before the writer", async () => {
    route({ sourceFields: { ...before, body: [{ value: "Another author's new paragraph", format: "basic_html", summary: "Keep" }] } });
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision({ input: { instanceId: "site", nodeId: "7", fields: { body: "Proposed from old body" }, expectedFields: { body: "Old body" } } } as never)).rejects.toThrow(/changed.*read|read.*changed/i);
    expect(writes()).toHaveLength(0);
  });
  it("accepts matching earlier values as comparison only, then returns actual stored fields", async () => {
    expect(await createDrupalPrimitiveHandlers().drupal_node_create_draft_revision({ input: { instanceId: "site", nodeId: "7", fields: { title: "Changed" }, expectedFields: { title: "Old" } } } as never)).toMatchObject({ pendingDraft: { beforeFields: { title: before.title } } });
    expect(writes()).toHaveLength(1);
  });
  it("keeps a valid returned revision as an inspection clue when its field envelope is malformed", async () => {
    route({ writer: { fields: {} } });
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request())).rejects.toThrow(/writer returned revision 11.*node 7.*language de/i);
    expect(writes()).toHaveLength(1);
  });
  it("preserves format and summary for a scalar body edit", async () => { await createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request({ body: "Changed body" })); expect(writes()[0][2]).toMatchObject({ updates: { body: [{ value: "Changed body", format: "basic_html", summary: "Keep" }] } }); });
  it.each([
    ["missing contract", { missingContract: true }], ["denied preimage", { readError: true }], ["pending draft", { preimage: { latest_revision_id: 11 } }], ["moderation alias", { preimage: { canonical_moderation_field: false } }], ["unmoderated", { preimage: { moderated: false } }], ["missing state", { preimage: { draft_states: {} } }], ["default-like state", { preimage: { draft_states: { working: { published: false, default_revision: true } } } }], ["wrong language", { preimage: { language: "en" } }], ["missing complete field names", { preimage: { available_fields: undefined } }], ["concurrent workflow", { second: { workflow_fingerprint: "b".repeat(64) } }], ["concurrent content", { second: { preimage_fingerprint: "d".repeat(64) } }], ["transition changed", { second: { draft_states: { other: { published: false, default_revision: false } }, allowed_draft_states: ["other"] } }],
  ] as const)("refuses %s before writing", async (_name, o) => { route(o); await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request())).rejects.toThrow(); expect(writes()).toHaveLength(0); });
  it("does not guess missing language", async () => { route({ node: { ...node, fields: { nid: 7, title: "Old" } } }); await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request())).rejects.toThrow(/language/i); expect(writes()).toHaveLength(0); });
  it("uses explicit translation rather than JSONAPI default language", async () => { route({ node: { ...node, fields: { ...node.fields, langcode: "en" } } }); await createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request({ title: "Changed" }, "de")); expect(writes()[0][2]).toMatchObject({ language: "de" }); });
  it("denies user authority before discovery", async () => { authority.mockRejectedValue(new Error("not authorized")); await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request())).rejects.toThrow("not authorized"); expect(callDrupalMcp).not.toHaveBeenCalled(); });
  it.each(["status", "moderation_state", "field_moderation_state", "revision_id", "path"])("rejects protected field %s", async (name) => { await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request({ [name]: "unsafe" }))).rejects.toThrow(); expect(writes()).toHaveLength(0); });
  it.each<[string, Overrides]>([
    ["writer old revision", { writer: { revision_id: 10 } }], ["writer live", { writer: { is_published: true } }], ["reader wrong revision", { reader: { revision_id: 12 } }], ["changed default", { reader: { default_revision_id: 11 } }], ["reader default", { reader: { is_default_revision: true } }], ["wrong node", { reader: { node_id: 8 } }], ["wrong UUID", { reader: { uuid: "other" } }], ["wrong language", { reader: { language: "en" } }], ["wrong state", { reader: { moderation_state: "live" } }], ["incomplete fields", { reader: { fields: { title: [{ value: "Changed" }] } } }], ["write uncertainty", { writeError: true }], ["read unavailable", { exactError: true }], ["writer/read disagree", { exactFields: { ...before, title: [{ value: "Other" }] } }], ["unrequested body drift", { storedFields: { body: [{ value: "Other", format: "basic_html", summary: "Keep" }] } }], ["scalar metadata drift", { storedFields: { title: [{ value: "Changed", extra: true }] } }],
  ])("reports %s honestly after writer dispatch", async (_name, o) => { route(o); let message = ""; try { await createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request()); } catch (error) { message = String(error); } expect(message).toMatch(/may have been saved|inspection required/i); expect(message).not.toMatch(/no (Drupal )?content was written|private provider detail/i); expect(writes()).toHaveLength(1); });
  it("keeps generic published refusal and contradictory identity refusal", async () => { await expect(createDrupalPrimitiveHandlers().drupal_node_update(request())).rejects.toThrow(/published.*protected draft/i); route({ node: { ...node, id: 8, status: false } }); await expect(createDrupalPrimitiveHandlers().drupal_node_update(request())).rejects.toThrow(/current.*status/i); expect(writes()).toHaveLength(0); });
});
