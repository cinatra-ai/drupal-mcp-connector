import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/drupal-mcp-client", () => ({ callDrupalMcp: vi.fn() }));
import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers, nodeCreateDraftSchema } from "../mcp/handlers";
import { registerDrupalConnector, type CmsReviewSeam } from "../deps";
const READ = "mcp_jsonapi_list_entities";
const STATE = "mcp_moderation_get_state";
const WORKFLOW = "mcp_moderation_get_workflow";
const instance = { id: "site", name: "Site", siteUrl: "https://example.test", nangoConnectionId: "site", providerConfigKey: "drupal", createdAt: "", updatedAt: "" };
const node = { entity_type: "node", id: 7, uuid: "uuid-7", bundle: "article", status: true, fields: { nid: 7, vid: 10, title: "Old", body: "Old body" } };
const state = { entity_type: "node", entity_id: 7, bundle: "article", workflow_id: "editorial", current_state: { id: "live", published: true, default_revision: true }, available_transitions: [{ id: "revise", to_state: "working" }] };
const workflow = { id: "editorial", entity_types: { node: ["article"] }, states: { live: { id: "live", published: true, default_revision: true }, working: { id: "working", published: false, default_revision: false } }, transitions: { revise: { id: "revise", from: ["live"], to: "working" } } };
const authority = vi.fn(async () => {});
function deps(cmsReview?: CmsReviewSeam) {
  registerDrupalConnector({
    decodeCursor: () => 0, buildListPage: (items, total) => ({ items, total }),
    dispatchContentEditor: async () => "{}", buildNangoBearerHeader: async () => ({ Authorization: "Bearer unit" }),
    listMcpInstances: () => [instance], probeMcp: async () => "registered", resolveMcpServerUrl: (s) => s,
    isPrivateUrl: () => false, isNangoConfigured: () => true, getApiStatus: async () => ({ instanceCount: 1, instances: [] }),
    saveInstance: vi.fn(), deleteInstance: vi.fn(), listInstanceStatuses: async () => [], requireInstanceWriteAuthority: authority, cmsReview,
  });
}
function route(overrides: Record<string, unknown> = {}) {
  vi.mocked(callDrupalMcp).mockImplementation(async (_instance, tool) => {
    const value = Object.hasOwn(overrides, tool) ? overrides[tool] : ({ [READ]: { items: [node] }, [STATE]: state, [WORKFLOW]: workflow } as Record<string, unknown>)[tool];
    if (value instanceof Error) throw value;
    return value ?? { nid: 8, revision_id: 11 };
  });
}
const writes = () => vi.mocked(callDrupalMcp).mock.calls.filter((c) => ["mcp_create_content", "mcp_update_content", "mcp_publish_content", "mcp_moderation_set_state"].includes(c[1]));
const request = { input: { instanceId: "site", nodeId: "7", fields: { title: "Changed" } } } as never;
beforeEach(() => { vi.clearAllMocks(); authority.mockResolvedValue(undefined); deps(); route(); });
describe("protected draft primitive before-write invariants", () => {
  it("takes nodeId and the complete atomic edit, not a new-node bundle/title request", () => {
    expect(nodeCreateDraftSchema.parse({ instanceId: "site", nodeId: "7", fields: { title: "Changed" } })).toEqual({ instanceId: "site", nodeId: "7", fields: { title: "Changed" } });
  });
  it("rejects the obsolete new-node create shape without creating stray content", async () => {
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision({ input: { instanceId: "site", nodeBundle: "article", title: "Draft" } } as never)).rejects.toThrow();
    expect(writes()).toHaveLength(0);
  });
  it("discovered moderation still refuses before any write when exact revision MCP read capability is absent", async () => {
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request)).rejects.toThrow(/exact.*revision.*MCP.*read/i);
    expect(vi.mocked(callDrupalMcp).mock.calls.map((c) => c[1])).toEqual([READ, STATE, WORKFLOW]);
    expect(writes()).toHaveLength(0);
    expect(node.status).toBe(true); expect(node.fields.title).toBe("Old");
  });
  it.each([
    ["moderation not enabled", STATE, new Error("entity is not moderated")],
    ["transition permission denied", STATE, new Error("permission denied")],
    ["workflow transport fails", WORKFLOW, new Error("transport unavailable")],
    ["moderation response malformed", STATE, null],
    ["workflow response malformed", WORKFLOW, null],
    ["workflow not assigned", STATE, { ...state, workflow_id: "" }],
  ])("refuses %s, with an actionable reason and no writes", async (_name, tool, value) => {
    route({ [tool]: value });
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request)).rejects.toThrow(/moderation|workflow/i);
    expect(writes()).toHaveLength(0);
  });
  it("per-user authority denies before even site discovery", async () => {
    authority.mockRejectedValue(new Error("not authorized"));
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request)).rejects.toThrow("not authorized");
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });
  it("generic update cannot bypass the protected draft path for a live node", async () => {
    await expect(createDrupalPrimitiveHandlers().drupal_node_update(request)).rejects.toThrow(/published.*protected draft/i);
    expect(writes()).toHaveLength(0);
  });
  it("a failed current-node read cannot become a generic live update", async () => {
    route({ [READ]: new Error("read unavailable") });
    await expect(createDrupalPrimitiveHandlers().drupal_node_update(request)).rejects.toThrow(/current.*status/i);
    expect(writes()).toHaveLength(0);
  });
  it("CMS review holds the proposed draft including its discovered unpublished status before any site write", async () => {
    const seam: CmsReviewSeam = {
      isReviewActive: () => true,
      captureStagedWrite: vi.fn(async () => ({ artifactId: "a", snapshotRevisionId: "r", snapshotTargetId: "t", operationId: "o", producedEventId: "e" })),
      resolveDisposition: async () => ({ disposition: "held", gate: { gateId: "g", runId: "run" } }),
      recordApplyVerification: vi.fn(async () => ({ ok: true, outcome: "verified" as const })),
    };
    deps(seam);
    expect(await createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request)).toMatchObject({ status: "pending_review", applied: false, nodeId: "7" });
    const captured = vi.mocked(seam.captureStagedWrite).mock.calls[0][0];
    expect(captured.scopeManifest.paths).toEqual(["status", "title"]);
    expect(JSON.parse(captured.resolved.text ?? "{}").status).toBe("unpublished");
    expect(writes()).toHaveLength(0);
    expect(seam.recordApplyVerification).not.toHaveBeenCalled();
  });
  it.each(["approved", "rejected"] as const)("CMS review %s never becomes a write or fake readback while the reader is missing", async (disposition) => {
    const seam: CmsReviewSeam = {
      isReviewActive: () => true,
      captureStagedWrite: vi.fn(async () => ({ artifactId: "a", snapshotRevisionId: "r", snapshotTargetId: "t", operationId: "o", producedEventId: "e" })),
      resolveDisposition: async () => ({ disposition, gate: { gateId: "g", runId: "run" } }),
      recordApplyVerification: vi.fn(async () => ({ ok: true, outcome: "verified" as const })),
    };
    deps(seam);
    await expect(createDrupalPrimitiveHandlers().drupal_node_create_draft_revision(request)).rejects.toThrow(disposition === "approved" ? /exact.*revision.*MCP.*read/i : /refused/i);
    expect(writes()).toHaveLength(0);
    expect(seam.recordApplyVerification).not.toHaveBeenCalled();
  });
  it("contradictory returned node identities cannot authorize generic update", async () => {
    route({ [READ]: { items: [{ ...node, id: 8, status: false, fields: { ...node.fields, nid: 7 } }] } });
    await expect(createDrupalPrimitiveHandlers().drupal_node_update(request)).rejects.toThrow(/current.*status/);
    expect(writes()).toHaveLength(0);
  });

});
