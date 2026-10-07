// The node write tools answer with the site tool's own result. Neither the
// update, the protected draft nor the publish tool captures a snapshot, holds an
// effect, or records a read-back: the connector gives its tools and creates no
// artifact. The review of a page change belongs to the application, over the
// page the agent files.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/drupal-mcp-client", () => ({
  callDrupalMcp: vi.fn(),
}));

import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "../mcp/handlers";
import {
  MODULE_READ_REVISION,
  MODULE_WRITE_DRAFT,
  PROTECTED_DRAFT_CONTRACT,
} from "../integration/module-protected-draft";
import { registerDrupalConnector, _resetDrupalDepsForTests, type DrupalConnectorDeps } from "../deps";

const INSTANCE = {
  id: "site-1",
  name: "Site",
  siteUrl: "https://example.test",
  nangoConnectionId: "site-1",
  providerConfigKey: "cinatra-drupal",
  createdAt: "",
  updatedAt: "",
};

const CLIENT_RESULT = { success: true, message: "done" };
const READ_TOOL = "mcp_jsonapi_list_entities";
const UNPUBLISHED_NODE = { items: [{ entity_type: "node", id: 7, status: false, fields: { nid: 7 } }] };

function makeHostDouble() {
  return {
    isReviewActive: vi.fn(() => true),
    captureStagedWrite: vi.fn(),
    resolveDisposition: vi.fn(async () => ({
      disposition: "held" as const,
      gate: { gateId: "g", runId: "r" },
    })),
    recordApplyVerification: vi.fn(),
  };
}

function registerDeps(hostDouble: ReturnType<typeof makeHostDouble>) {
  registerDrupalConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items: unknown[], total: number, offset: number, limit: number) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: vi.fn(async () => ""),
    buildNangoBearerHeader: vi.fn(async () => ({ Authorization: "Bearer t" })),
    listMcpInstances: () => [INSTANCE],
    probeMcp: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl.replace(/\/+$/, "") + "/_mcp_tools",
    isPrivateUrl: () => false,
    isNangoConfigured: () => true,
    getApiStatus: vi.fn(async () => ({ instanceCount: 1, instances: [INSTANCE] })),
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: vi.fn(async () => []),
    requireInstanceWriteAuthority: vi.fn(async () => {}),
    cmsReview: hostDouble,
  } as unknown as DrupalConnectorDeps);
}

function expectHostDoubleUntouched(hostDouble: ReturnType<typeof makeHostDouble>) {
  expect(hostDouble.isReviewActive).toHaveBeenCalledTimes(0);
  expect(hostDouble.captureStagedWrite).toHaveBeenCalledTimes(0);
  expect(hostDouble.resolveDisposition).toHaveBeenCalledTimes(0);
  expect(hostDouble.recordApplyVerification).toHaveBeenCalledTimes(0);
}

beforeEach(() => {
  vi.mocked(callDrupalMcp).mockReset();
  vi.mocked(callDrupalMcp).mockResolvedValue(CLIENT_RESULT);
});

afterEach(() => {
  _resetDrupalDepsForTests();
});

describe("node write tools answer with the tool's own result", () => {
  it("U1: drupal_node_update reads the node's status, then returns the client's object from exactly one write call", async () => {
    const hostDouble = makeHostDouble();
    registerDeps(hostDouble);
    vi.mocked(callDrupalMcp).mockImplementation(async (_instance, tool) =>
      tool === READ_TOOL ? UNPUBLISHED_NODE : CLIENT_RESULT,
    );
    const handlers = createDrupalPrimitiveHandlers();

    const result = await handlers.drupal_node_update({
      input: { instanceId: "site-1", nodeId: "7", fields: { title: "New title" } },
    } as never);

    expect(result).toBe(CLIENT_RESULT);
    expect(vi.mocked(callDrupalMcp).mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [READ_TOOL, { entity_type: "node", filters: { nid: 7 }, limit: 1 }],
      ["mcp_update_content", { nid: "7", updates: { title: "New title" } }],
    ]);
    expectHostDoubleUntouched(hostDouble);
  });

  it("P1: drupal_node_publish returns the client's object and makes exactly one client call", async () => {
    const hostDouble = makeHostDouble();
    registerDeps(hostDouble);
    const handlers = createDrupalPrimitiveHandlers();

    const result = await handlers.drupal_node_publish({
      input: { instanceId: "site-1", nodeId: "7" },
    } as never);

    expect(result).toBe(CLIENT_RESULT);
    expect(vi.mocked(callDrupalMcp).mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["mcp_publish_content", { nid: "7", publish: true }],
    ]);
    expectHostDoubleUntouched(hostDouble);
  });

  it("D1: drupal_node_create_draft_revision writes the draft once and answers with the stored revision", async () => {
    const hostDouble = makeHostDouble();
    registerDeps(hostDouble);
    const before = { title: [{ value: "Old" }] };
    const preimage = {
      node_id: 7, uuid: "uuid-7", language: "de", default_revision_id: 10, latest_revision_id: 10,
      is_default_revision: true, is_published: true, moderated: true, canonical_moderation_field: true,
      workflow_fingerprint: "a".repeat(64), preimage_fingerprint: "c".repeat(64),
      draft_states: { working: { published: false, default_revision: false } },
      allowed_draft_states: ["working"], available_fields: ["title"], fields: before,
    };
    const stored = {
      node_id: 7, uuid: "uuid-7", language: "de", revision_id: 11, default_revision_id: 10,
      is_default_revision: false, is_published: false, moderation_state: "working",
      fields: { title: [{ value: "New title" }] },
    };
    vi.mocked(callDrupalMcp).mockImplementation(async (_instance, tool, raw) => {
      if (tool === READ_TOOL) {
        return { items: [{ entity_type: "node", id: 7, uuid: "uuid-7", status: true, fields: { nid: 7, langcode: "de" } }] };
      }
      if (tool === MODULE_READ_REVISION) {
        const exact = (raw as { revision_id?: unknown }).revision_id !== undefined;
        return { contract: PROTECTED_DRAFT_CONTRACT, result: exact ? stored : preimage };
      }
      if (tool === MODULE_WRITE_DRAFT) return { contract: PROTECTED_DRAFT_CONTRACT, result: stored };
      throw new Error(`unexpected tool ${tool}`);
    });
    const handlers = createDrupalPrimitiveHandlers();

    const result = await handlers.drupal_node_create_draft_revision({
      input: { instanceId: "site-1", nodeId: "7", fields: { title: "New title" } },
    } as never);

    expect(result).toEqual({
      nodeId: "7", revision_id: 11, status: "draft", applied: true, fields: stored.fields,
      pendingDraft: { nodeId: "7", revisionId: 11, language: "de", beforeFields: before, fields: stored.fields },
    });
    expect(vi.mocked(callDrupalMcp).mock.calls.filter((c) => c[1] === MODULE_WRITE_DRAFT)).toHaveLength(1);
    expectHostDoubleUntouched(hostDouble);
  });
});
