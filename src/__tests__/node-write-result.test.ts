// The node write tools answer with the site tool's own result. Neither the
// update nor the publish tool captures a snapshot, holds an effect, or records a
// read-back: the connector gives its tools and creates no artifact. The review
// of a page change belongs to the application, over the page the agent files.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/drupal-mcp-client", () => ({
  callDrupalMcp: vi.fn(),
}));

import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "../mcp/handlers";
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
  it("U1: drupal_node_update returns the client's object and makes exactly one client call", async () => {
    const hostDouble = makeHostDouble();
    registerDeps(hostDouble);
    const handlers = createDrupalPrimitiveHandlers();

    const result = await handlers.drupal_node_update({
      input: { instanceId: "site-1", nodeId: "7", fields: { title: "New title" } },
    } as never);

    expect(result).toBe(CLIENT_RESULT);
    expect(vi.mocked(callDrupalMcp).mock.calls.map((c) => [c[1], c[2]])).toEqual([
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
});
