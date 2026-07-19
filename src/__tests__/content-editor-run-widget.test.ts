import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// S5 delegated-widget OBO reconstruction (cinatra S5-W1 §5 G3/G4) — the
// CONNECTOR-side subset of the T1-T8 negative-test contract.
//
// `drupal_content_editor_run` reads the trusted `public_site_widget` delegated
// actor the host derives from the MCP request frame (the `resolveWidgetActor`
// deps seam — NEVER tool input). When present it must:
//   (a) FAIL-CLOSED assert the tool-arg instanceId === the actor's server-pinned
//       instance (`instance_pin_mismatch`);
//   (b) build actorOverride {runBy, orgId, instanceId, sourceType:
//       "public_site_widget"} and thread it into dispatchContentEditor;
//   (c) on a widget delegation MISSING the pinned fields, THROW (no dispatch);
//   (d) on the normal (non-widget) path, dispatch byte-identically to today
//       (no actorOverride key).

vi.mock("../lib/drupal-mcp-client", () => ({
  callDrupalMcp: vi.fn(),
}));

import { createDrupalPrimitiveHandlers } from "@cinatra-ai/drupal-mcp-connector/mcp-handlers";
import {
  registerDrupalConnector,
  _resetDrupalDepsForTests,
  type WidgetActorContext,
} from "../deps";

const dispatchMock = vi.fn(
  async (_input: {
    agentUrl: string;
    payload: unknown;
    timeoutMs: number;
    actorOverride?: unknown;
  }) => '{"nodeId":"24","changes":[]}',
);

function registerDepsStub(resolveWidgetActor?: () => WidgetActorContext | null) {
  registerDrupalConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: dispatchMock,
    ...(resolveWidgetActor ? { resolveWidgetActor } : {}),
    buildNangoBearerHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
    listMcpInstances: () => [],
    probeMcp: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl.replace(/\/+$/, "") + "/_mcp_tools",
    isPrivateUrl: () => false,
    isNangoConfigured: () => true,
    getApiStatus: vi.fn(async () => ({ instanceCount: 0, instances: [] })),
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: vi.fn(async () => []),
    requireInstanceWriteAuthority: vi.fn(async () => {}),
  });
}

const WIDGET_ACTOR: WidgetActorContext = {
  delegation: "public_site_widget",
  runBy: "user-77",
  orgId: "org-9",
  instanceId: "site-1",
};

function callRun(input: Record<string, unknown>) {
  const handlers = createDrupalPrimitiveHandlers();
  return (handlers as any).drupal_content_editor_run({
    primitiveName: "drupal_content_editor_run",
    input,
    actor: { actorType: "model", source: "agent" },
    mode: "agentic",
  });
}

describe("drupal_content_editor_run — S5 delegated-widget OBO", () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue('{"nodeId":"24","changes":[]}');
  });

  afterEach(() => {
    _resetDrupalDepsForTests();
  });

  it("widget path: builds the pinned actorOverride and threads it into dispatch", async () => {
    registerDepsStub(() => WIDGET_ACTOR);
    await callRun({ instanceId: "site-1", nodeId: "24", instructions: "Update title" });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0][0];
    expect(arg.actorOverride).toEqual({
      runBy: "user-77",
      orgId: "org-9",
      instanceId: "site-1",
      sourceType: "public_site_widget",
    });
  });

  it("instance pin (G3): tool-arg instanceId != pinned instance → instance_pin_mismatch, no dispatch", async () => {
    registerDepsStub(() => ({ ...WIDGET_ACTOR, instanceId: "site-1" }));
    await expect(
      callRun({ instanceId: "site-EVIL", nodeId: "24", instructions: "x" }),
    ).rejects.toThrow(/instance_pin_mismatch/);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("missing override fields on a widget call → fail-closed throw, no dispatch", async () => {
    registerDepsStub(() => ({ ...WIDGET_ACTOR, runBy: "" }));
    await expect(
      callRun({ instanceId: "site-1", nodeId: "24", instructions: "x" }),
    ).rejects.toThrow(/missing the pinned actor fields/);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("non-widget path (resolver returns null): dispatch carries NO actorOverride", async () => {
    registerDepsStub(() => null);
    await callRun({ instanceId: "site-1", nodeId: "24", instructions: "x" });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0][0];
    expect("actorOverride" in arg).toBe(false);
  });

  it("skew (resolver unbound): dispatch carries NO actorOverride (byte-identical)", async () => {
    registerDepsStub(); // no resolveWidgetActor bound
    await callRun({ instanceId: "site-1", nodeId: "24", instructions: "x" });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0][0];
    expect("actorOverride" in arg).toBe(false);
  });
});
