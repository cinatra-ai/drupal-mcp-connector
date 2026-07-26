import { describe, expect, it, vi, beforeEach } from "vitest";

// The MCP transport is mocked so these handler tests assert the MCP tool calls
// (and, crucially, their ABSENCE while a staged write is held), not a live site.
vi.mock("../lib/drupal-mcp-client", () => ({
  callDrupalMcp: vi.fn(),
}));

import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "@cinatra-ai/drupal-mcp-connector/mcp-handlers";
import { registerDrupalConnector, type DrupalConnectorDeps, type CmsReviewSeam } from "../deps";

const READ_TOOL = "mcp_jsonapi_list_entities";
const UPDATE_TOOL = "mcp_update_content";
const PUBLISH_TOOL = "mcp_publish_content";

const instance = {
  id: "site-1",
  name: "Site 1",
  siteUrl: "http://localhost:8592",
  nangoConnectionId: "site-1",
  providerConfigKey: "cinatra-drupal",
  createdAt: "",
  updatedAt: "",
};

function registerStubDeps(extra: Partial<DrupalConnectorDeps> = {}) {
  registerDrupalConnector({
    decodeCursor: () => 0,
    buildListPage: (items, total) => ({ items, total }),
    dispatchContentEditor: vi.fn(async () => "{}"),
    buildNangoBearerHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
    listMcpInstances: () => [instance],
    probeMcp: async () => "registered" as const,
    resolveMcpServerUrl: (s: string) => s,
    isPrivateUrl: () => false,
    isNangoConfigured: () => true,
    getApiStatus: vi.fn(async () => ({ instanceCount: 1, instances: [] as unknown[] })),
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: vi.fn(async () => []),
    requireInstanceWriteAuthority: vi.fn(async () => {}),
    ...extra,
  } as unknown as DrupalConnectorDeps);
}

/** The serialized entity `mcp_jsonapi_list_entities` returns for node 7. */
const entity = (fields: Record<string, unknown> = {}) => ({
  items: [
    {
      id: 7,
      uuid: "u-7",
      bundle: "article",
      label: "Old title",
      status: true,
      fields: { nid: 7, title: "Old title", body: "<p>Old body</p>", ...fields },
    },
  ],
  total: 1,
});

/** Route the single callDrupalMcp mock by tool name. `postApply` (when given) is
 * the field map the SECOND read (the independent post-apply re-read) returns. */
function routeMcp(opts: { postApply?: Record<string, unknown> } = {}) {
  let reads = 0;
  vi.mocked(callDrupalMcp).mockImplementation(async (_instance, tool) => {
    if (tool === READ_TOOL) {
      reads += 1;
      return reads > 1 && opts.postApply ? entity(opts.postApply) : entity();
    }
    return { success: true };
  });
}

function makeSeam(overrides: Partial<CmsReviewSeam> = {}): CmsReviewSeam {
  return {
    isReviewActive: () => true,
    captureStagedWrite: vi.fn(async () => ({
      artifactId: "art-1",
      snapshotRevisionId: "rev-1",
      snapshotTargetId: "tgt-1",
      operationId: "op-1",
      producedEventId: "ev-1",
    })),
    resolveDisposition: vi.fn(async () => ({
      disposition: "held" as const,
      gate: { gateId: "gate-1", runId: "run-1" },
    })),
    recordApplyVerification: vi.fn(async () => ({ ok: true, outcome: "verified" as const })),
    ...overrides,
  };
}

const toolsCalled = () => vi.mocked(callDrupalMcp).mock.calls.map((c) => c[1]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("drupal_node_update — S7 review trigger", () => {
  it("FENCE OFF (no cmsReview seam): byte-identical — updates with no read and no capture", async () => {
    registerStubDeps();
    routeMcp();
    const res = await createDrupalPrimitiveHandlers().drupal_node_update({
      input: { instanceId: "site-1", nodeId: "7", fields: { title: "New title" } },
    } as never);
    expect(toolsCalled()).toEqual([UPDATE_TOOL]);
    expect(res).toEqual({ success: true });
  });

  it("FENCE OFF (seam bound, isReviewActive false): byte-identical, no read/capture", async () => {
    const seam = makeSeam({ isReviewActive: () => false });
    registerStubDeps({ cmsReview: seam });
    routeMcp();
    await createDrupalPrimitiveHandlers().drupal_node_update({
      input: { instanceId: "site-1", nodeId: "7", fields: { title: "New title" } },
    } as never);
    expect(toolsCalled()).toEqual([UPDATE_TOOL]);
    expect(seam.captureStagedWrite).not.toHaveBeenCalled();
  });

  it("FENCE ON, gate held: captures the proposal + manifest and HOLDS — Drupal is NOT written", async () => {
    const seam = makeSeam();
    registerStubDeps({ cmsReview: seam });
    routeMcp();
    const res = (await createDrupalPrimitiveHandlers().drupal_node_update({
      input: { instanceId: "site-1", nodeId: "7", fields: { title: "New title" } },
    } as never)) as Record<string, unknown>;
    // The read happened (the CAS base); the WRITE did NOT.
    expect(toolsCalled()).toEqual([READ_TOOL]);
    expect(toolsCalled()).not.toContain(UPDATE_TOOL);
    expect(res).toMatchObject({ status: "pending_review", applied: false, nodeId: "7" });
    expect(vi.mocked(seam.captureStagedWrite).mock.calls[0][0].scopeManifest).toEqual({
      paths: ["title"],
    });
  });

  it("FENCE ON, gate approved: applies the write AND records the read-back from an INDEPENDENT re-read", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({
        disposition: "approved" as const,
        gate: { gateId: "gate-1", runId: "run-1" },
      })),
    });
    registerStubDeps({ cmsReview: seam });
    // The re-read returns a body a site module rewrote on save — out of scope.
    routeMcp({ postApply: { title: "New title", body: "<p>Old body</p>[rewritten]" } });
    const res = (await createDrupalPrimitiveHandlers().drupal_node_update({
      input: { instanceId: "site-1", nodeId: "7", fields: { title: "New title" } },
    } as never)) as Record<string, unknown>;
    // read (base) → update → read (independent post-apply re-read).
    expect(toolsCalled()).toEqual([READ_TOOL, UPDATE_TOOL, READ_TOOL]);
    const readback = vi.mocked(seam.recordApplyVerification).mock.calls[0][0];
    expect(readback.gateId).toBe("gate-1");
    expect(readback.postApplyFields).toEqual({
      title: "New title",
      body: "<p>Old body</p>[rewritten]",
      status: "published",
      // `flattenMcpNode` always surfaces `summary` (the module collapses the
      // compound body field), so it is part of the reviewed projection on BOTH
      // sides — symmetric, and therefore never drift.
      summary: "",
    });
    expect(res.review).toMatchObject({ ok: true, outcome: "verified" });
  });

  it("FENCE ON, gate rejected: refuses — the write never reaches Drupal", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "rejected" as const, gate: null })),
    });
    registerStubDeps({ cmsReview: seam });
    routeMcp();
    await expect(
      createDrupalPrimitiveHandlers().drupal_node_update({
        input: { instanceId: "site-1", nodeId: "7", fields: { title: "New title" } },
      } as never),
    ).rejects.toThrow(/rejected/);
    expect(toolsCalled()).not.toContain(UPDATE_TOOL);
  });
});

describe("drupal_node_publish — S7 review trigger (the Drupal-only publish seam)", () => {
  it("FENCE OFF: byte-identical — publishes with no read and no capture", async () => {
    registerStubDeps();
    routeMcp();
    await createDrupalPrimitiveHandlers().drupal_node_publish({
      input: { instanceId: "site-1", nodeId: "7" },
    } as never);
    expect(toolsCalled()).toEqual([PUBLISH_TOOL]);
  });

  it("FENCE ON, unpublished node: HOLDS the publish effect — Drupal is NOT published", async () => {
    const seam = makeSeam();
    registerStubDeps({ cmsReview: seam });
    let reads = 0;
    vi.mocked(callDrupalMcp).mockImplementation(async (_i, tool) => {
      if (tool === READ_TOOL) {
        reads += 1;
        return { items: [{ id: 7, bundle: "article", status: false, fields: { nid: 7, title: "T", body: "B" } }], total: 1 };
      }
      return { success: true };
    });
    const res = (await createDrupalPrimitiveHandlers().drupal_node_publish({
      input: { instanceId: "site-1", nodeId: "7" },
    } as never)) as Record<string, unknown>;
    expect(reads).toBe(1);
    expect(toolsCalled()).not.toContain(PUBLISH_TOOL);
    expect(res).toMatchObject({ status: "pending_review", applied: false });
    expect(vi.mocked(seam.captureStagedWrite).mock.calls[0][0].scopeManifest).toEqual({
      paths: ["status"],
    });
  });

  it("FENCE ON, already-published node: no gate, the publish call proceeds unchanged", async () => {
    const seam = makeSeam();
    registerStubDeps({ cmsReview: seam });
    routeMcp();
    await createDrupalPrimitiveHandlers().drupal_node_publish({
      input: { instanceId: "site-1", nodeId: "7" },
    } as never);
    expect(toolsCalled()).toEqual([READ_TOOL, PUBLISH_TOOL]);
    expect(seam.captureStagedWrite).not.toHaveBeenCalled();
  });
});
