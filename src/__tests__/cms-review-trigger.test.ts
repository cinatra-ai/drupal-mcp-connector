import { describe, expect, it, vi } from "vitest";

import {
  buildCmsScopeManifest,
  buildStagedWriteCapture,
  canonicalizeFieldValue,
  canonicalizeStatus,
  deriveCmsOperationId,
  drupalNodeUrl,
  evaluateStagedNodeWrite,
  projectNodeFields,
  resolveProposedState,
  resolveReviewablePaths,
  serializeCmsFields,
  stableStringify,
  unreviewableProposalPaths,
  CMS_REVIEW_SNAPSHOT_MIME,
  DRUPAL_STATUS_PUBLISHED,
  DRUPAL_STATUS_UNPUBLISHED,
} from "../integration/cms-review-trigger";
import type { CmsReviewSeam } from "../deps";

// A flattened Drupal node the way `mcp_jsonapi_list_entities` (via
// `flattenMcpNode`) hands it to the handler: identity + volatile metadata mixed
// with the editable content fields and declared `field_*` regions.
const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "7",
  nid: 7,
  uuid: "u-7",
  bundle: "article",
  langcode: "en",
  changed: "1770000000",
  revision_timestamp: "1770000000",
  title: "Old title",
  body: "<p>Old body</p>",
  summary: "",
  status: true,
  field_subtitle: "Old subtitle",
  ...over,
});

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

describe("canonicalizeStatus / canonicalizeFieldValue", () => {
  it("normalizes every Drupal publish-status spelling to one vocabulary", () => {
    for (const published of [true, 1, "1", "true", "published", "publish"]) {
      expect(canonicalizeStatus(published)).toBe(DRUPAL_STATUS_PUBLISHED);
    }
    for (const unpublished of [false, 0, "0", "false", "unpublished", "draft"]) {
      expect(canonicalizeStatus(unpublished)).toBe(DRUPAL_STATUS_UNPUBLISHED);
    }
  });

  it("omits absent values instead of coercing them to an empty string", () => {
    expect(canonicalizeFieldValue("title", undefined)).toBeUndefined();
    expect(canonicalizeFieldValue("title", null)).toBeUndefined();
    expect(canonicalizeFieldValue("status", null)).toBeUndefined();
  });

  it("flattens typed Drupal field values deterministically", () => {
    expect(canonicalizeFieldValue("title", "T")).toBe("T");
    expect(canonicalizeFieldValue("field_weight", 3)).toBe("3");
    expect(canonicalizeFieldValue("field_flag", true)).toBe("true");
    expect(canonicalizeFieldValue("field_tags", ["a", "b"])).toBe('["a","b"]');
  });
});

describe("resolveReviewablePaths", () => {
  it("carries content + declared field regions and EXCLUDES identity/volatile keys", () => {
    const paths = resolveReviewablePaths(node(), { title: "New" });
    expect(paths).toEqual(["body", "field_subtitle", "status", "summary", "title"]);
    for (const sys of ["id", "nid", "uuid", "bundle", "langcode", "changed", "revision_timestamp"]) {
      expect(paths).not.toContain(sys);
    }
  });

  it("includes a path the proposal introduces even when the node lacks it", () => {
    expect(resolveReviewablePaths(node(), { field_new: "x" })).toContain("field_new");
  });
});

describe("serializeCmsFields", () => {
  it("emits a key-SORTED object (the Drupal path set is open, so order is derived)", () => {
    expect(serializeCmsFields({ title: "T", body: "B", field_a: "A" })).toBe(
      '{"body":"B","field_a":"A","title":"T"}',
    );
  });

  it("is stable regardless of input key order", () => {
    expect(serializeCmsFields({ body: "B", title: "T" })).toBe(serializeCmsFields({ title: "T", body: "B" }));
  });
});

describe("projectNodeFields", () => {
  it("projects the SAME canonical bytes for the capture base and a re-read", () => {
    const paths = ["title", "body", "status"];
    // The same node arriving with `status` as a bool and as "1" must project
    // identically — an asymmetric projection would read as phantom drift.
    expect(projectNodeFields(node({ status: true }), paths)).toEqual(
      projectNodeFields(node({ status: "1" }), paths),
    );
  });

  it("omits paths the node does not carry", () => {
    expect(projectNodeFields(node(), ["title", "field_absent"])).toEqual({ title: "Old title" });
  });
});

describe("resolveProposedState", () => {
  it("carries unchanged fields from current and flags only changed paths", () => {
    const r = resolveProposedState(node(), { title: "New title" });
    expect(r.changedPaths).toEqual(["title"]);
    expect(r.proposedState).toEqual({
      body: "<p>Old body</p>",
      field_subtitle: "Old subtitle",
      status: DRUPAL_STATUS_PUBLISHED,
      summary: "",
      title: "New title",
    });
  });

  it("flags a declared field region edit", () => {
    expect(resolveProposedState(node(), { field_subtitle: "New subtitle" }).changedPaths).toEqual([
      "field_subtitle",
    ]);
  });

  it("flags an unpublished→published transition as a reviewed path", () => {
    const r = resolveProposedState(node({ status: false }), { status: DRUPAL_STATUS_PUBLISHED });
    expect(r.changedPaths).toEqual(["status"]);
    expect(r.proposedState.status).toBe(DRUPAL_STATUS_PUBLISHED);
  });

  it("reports NO change when the status proposal restates the current publish state", () => {
    expect(resolveProposedState(node({ status: true }), { status: DRUPAL_STATUS_PUBLISHED }).changedPaths)
      .toEqual([]);
  });

  it("reports no change when the proposal equals current", () => {
    expect(resolveProposedState(node(), { title: "Old title" }).changedPaths).toEqual([]);
  });
});

describe("deriveCmsOperationId", () => {
  const base = {
    instanceId: "site-1",
    resourceType: "article",
    cmsResourceId: "7",
    scopePaths: ["title"],
    baseRemoteRevisionRef: "base-1",
    effect: "update",
    proposedSerialization: '{"title":"T"}',
  };

  it("is deterministic for an identical proposal against the same base", () => {
    expect(deriveCmsOperationId(base)).toBe(deriveCmsOperationId({ ...base }));
  });

  it("differs for a different proposal, node, and instance", () => {
    const a = deriveCmsOperationId(base);
    expect(deriveCmsOperationId({ ...base, proposedSerialization: '{"title":"U"}' })).not.toBe(a);
    expect(deriveCmsOperationId({ ...base, cmsResourceId: "8" })).not.toBe(a);
    expect(deriveCmsOperationId({ ...base, instanceId: "site-2" })).not.toBe(a);
  });

  it("binds the AUTHORIZED scope, the base, and the effect (no cross-authorization reuse)", () => {
    const a = deriveCmsOperationId(base);
    // Same final state, DIFFERENT authorized scope → a different operation.
    expect(deriveCmsOperationId({ ...base, scopePaths: ["title", "body"] })).not.toBe(a);
    // Same final state computed against a THIRD-PARTY-changed base → different.
    expect(deriveCmsOperationId({ ...base, baseRemoteRevisionRef: "base-2" })).not.toBe(a);
    // The publish seam is a distinct effect from the content update.
    expect(deriveCmsOperationId({ ...base, effect: "publish" })).not.toBe(a);
  });

  it("is scope-order independent", () => {
    expect(deriveCmsOperationId({ ...base, scopePaths: ["body", "title"] })).toBe(
      deriveCmsOperationId({ ...base, scopePaths: ["title", "body"] }),
    );
  });
});

describe("stableStringify / unreviewableProposalPaths", () => {
  it("serializes nested object keys in a stable order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("flags identity/volatile paths and values with no canonical form", () => {
    expect(unreviewableProposalPaths({ title: "T" })).toEqual([]);
    expect(unreviewableProposalPaths({ body: null })).toEqual(["body"]);
    expect(unreviewableProposalPaths({ uid: 5, title: "T" })).toEqual(["uid"]);
  });
});

describe("buildStagedWriteCapture", () => {
  it("passes the proposed content + scope manifest + identity coordinates", () => {
    const { currentState, proposedState, changedPaths } = resolveProposedState(node(), { title: "New title" });
    const capture = buildStagedWriteCapture({
      instanceId: "site-1",
      resourceType: "article",
      nodeId: 7,
      siteUrl: "http://localhost:8592/",
      currentState,
      proposedState,
      changedPaths,
      capturedAt: "2026-07-26T00:00:00.000Z",
    });
    expect(capture.pointer).toMatchObject({
      url: "http://localhost:8592/node/7",
      connectorId: "@cinatra-ai/drupal-mcp-connector",
      externalId: "site-1:7",
      resolvedMimeType: CMS_REVIEW_SNAPSHOT_MIME,
      state: "linked",
      title: "New title",
    });
    expect(capture.resolved.mime).toBe(CMS_REVIEW_SNAPSHOT_MIME);
    expect(JSON.parse(String(capture.resolved.text))).toEqual(proposedState);
    expect(capture.scopeManifest).toEqual({ paths: ["title"] });
    expect(capture.connectorInstance).toBe("site-1");
    expect(capture.resourceType).toBe("article");
    expect(capture.cmsResourceId).toBe("7");
    expect(capture.baseRemoteRevisionRef).toMatch(/^[0-9a-f]{64}$/);
    expect(capture.operationId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("anchors the CAS ref on the CURRENT state (a third-party edit changes it)", () => {
    const args = {
      instanceId: "site-1",
      resourceType: "article",
      nodeId: 7,
      siteUrl: "http://localhost:8592",
      changedPaths: ["title"],
      capturedAt: "2026-07-26T00:00:00.000Z",
    };
    const a = buildStagedWriteCapture({
      ...args,
      currentState: { title: "Old title" },
      proposedState: { title: "New title" },
    });
    const b = buildStagedWriteCapture({
      ...args,
      currentState: { title: "Third-party title" },
      proposedState: { title: "New title" },
    });
    expect(a.baseRemoteRevisionRef).not.toBe(b.baseRemoteRevisionRef);
    // …and the operation id is BOUND to that base, so a re-drive against a
    // third-party-changed base mints a NEW target instead of riding an approval
    // taken against the stale one (a codex convergence finding).
    expect(a.operationId).not.toBe(b.operationId);
  });
});

describe("buildCmsScopeManifest / drupalNodeUrl", () => {
  it("closes the manifest over the changed paths only", () => {
    expect(buildCmsScopeManifest(["title", "body"])).toEqual({ paths: ["title", "body"] });
  });
  it("composes an absolute node URL, trimming trailing slashes", () => {
    expect(drupalNodeUrl("http://localhost:8592//", 7)).toBe("http://localhost:8592/node/7");
  });
});

describe("evaluateStagedNodeWrite — fence OFF / no seam (byte-identical)", () => {
  it("returns pass WITHOUT reading the node or capturing when the seam is unbound", async () => {
    const fetchCurrent = vi.fn(async () => node());
    const decision = await evaluateStagedNodeWrite({
      seam: undefined,
      instanceId: "site-1",
      siteUrl: "http://localhost:8592",
      nodeId: 7,
      proposed: { title: "New" },
      fetchCurrent,
    });
    expect(decision).toEqual({ action: "pass" });
    expect(fetchCurrent).not.toHaveBeenCalled();
  });

  it("returns pass WITHOUT reading the node when the review fence is inactive", async () => {
    const fetchCurrent = vi.fn(async () => node());
    const seam = makeSeam({ isReviewActive: () => false });
    const decision = await evaluateStagedNodeWrite({
      seam,
      instanceId: "site-1",
      siteUrl: "http://localhost:8592",
      nodeId: 7,
      proposed: { title: "New" },
      fetchCurrent,
    });
    expect(decision).toEqual({ action: "pass" });
    expect(fetchCurrent).not.toHaveBeenCalled();
    expect(seam.captureStagedWrite).not.toHaveBeenCalled();
  });
});

describe("evaluateStagedNodeWrite — fence ON", () => {
  const args = {
    instanceId: "site-1",
    siteUrl: "http://localhost:8592",
    nodeId: 7,
    now: () => new Date("2026-07-26T00:00:00.000Z"),
  };

  it("captures the proposed content + scope manifest and HOLDS when the gate is pending", async () => {
    const seam = makeSeam();
    const decision = await evaluateStagedNodeWrite({
      ...args,
      seam,
      proposed: { title: "New title" },
      fetchCurrent: async () => node(),
    });
    expect(decision.action).toBe("hold");
    const captured = vi.mocked(seam.captureStagedWrite).mock.calls[0][0];
    expect(captured.scopeManifest).toEqual({ paths: ["title"] });
    expect(captured.resourceType).toBe("article");
    expect(JSON.parse(String(captured.resolved.text)).title).toBe("New title");
    if (decision.action !== "hold") throw new Error("unreachable");
    expect(decision.pending).toMatchObject({
      status: "pending_review",
      applied: false,
      nodeId: "7",
      resourceType: "article",
      reviewedPaths: ["title"],
      gate: { gateId: "gate-1", runId: "run-1" },
    });
  });

  it("does NOT capture and returns pass when nothing actually changes", async () => {
    const seam = makeSeam();
    const decision = await evaluateStagedNodeWrite({
      ...args,
      seam,
      proposed: { title: "Old title" },
      fetchCurrent: async () => node(),
    });
    expect(decision).toEqual({ action: "pass" });
    expect(seam.captureStagedWrite).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the full-field read is unavailable (a summary row is no review base)", async () => {
    const seam = makeSeam();
    const decision = await evaluateStagedNodeWrite({
      ...args,
      seam,
      proposed: { title: "New title" },
      fetchCurrent: async () => null,
    });
    expect(decision.action).toBe("reject");
    expect(seam.captureStagedWrite).not.toHaveBeenCalled();
  });

  it("returns apply (with the gate + the snapshot key set) when the disposition is approved", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({
        disposition: "approved" as const,
        gate: { gateId: "gate-1", runId: "run-1" },
      })),
    });
    const decision = await evaluateStagedNodeWrite({
      ...args,
      seam,
      proposed: { title: "New title" },
      fetchCurrent: async () => node(),
    });
    expect(decision).toEqual({
      action: "apply",
      operationId: expect.stringMatching(/^[0-9a-f]{64}$/),
      gate: { gateId: "gate-1", runId: "run-1" },
      snapshotPaths: ["body", "field_subtitle", "status", "summary", "title"],
    });
  });

  it("returns reject when the disposition is rejected", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "rejected" as const, gate: null })),
    });
    const decision = await evaluateStagedNodeWrite({
      ...args,
      seam,
      proposed: { title: "New title" },
      fetchCurrent: async () => node(),
    });
    expect(decision.action).toBe("reject");
  });

  it("refuses fail-closed on an indeterminate disposition", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "unknown" as const, gate: null })),
    });
    const decision = await evaluateStagedNodeWrite({
      ...args,
      seam,
      proposed: { title: "New title" },
      fetchCurrent: async () => node(),
    });
    expect(decision.action).toBe("reject");
  });

  it("passes (org-permitted apply) when the disposition is ungated", async () => {
    const seam = makeSeam({
      resolveDisposition: vi.fn(async () => ({ disposition: "ungated" as const, gate: null })),
    });
    const decision = await evaluateStagedNodeWrite({
      ...args,
      seam,
      proposed: { title: "New title" },
      fetchCurrent: async () => node(),
    });
    expect(decision).toEqual({ action: "pass" });
  });

  it("falls back to the generic `node` resourceType when the bundle is absent", async () => {
    const seam = makeSeam();
    await evaluateStagedNodeWrite({
      ...args,
      seam,
      proposed: { title: "New title" },
      fetchCurrent: async () => node({ bundle: undefined }),
    });
    expect(vi.mocked(seam.captureStagedWrite).mock.calls[0][0].resourceType).toBe("node");
  });

  it("gates the PUBLISH transition with a status-only manifest", async () => {
    const seam = makeSeam();
    const decision = await evaluateStagedNodeWrite({
      ...args,
      seam,
      proposed: { status: DRUPAL_STATUS_PUBLISHED },
      fetchCurrent: async () => node({ status: false }),
    });
    expect(decision.action).toBe("hold");
    expect(vi.mocked(seam.captureStagedWrite).mock.calls[0][0].scopeManifest).toEqual({
      paths: ["status"],
    });
  });
});
