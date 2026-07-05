import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// drupal_content_editor_run reply-text handling.
//
// The A2A transport (bearer mint + client + sendTask + task.history walk) now
// lives HOST-side behind `deps.dispatchContentEditor`, which resolves with the
// agent's reply TEXT. The connector keeps only the stripCodeFences + JSON.parse
// of that text. These tests register a deps stub and assert that text handling:
//   1. JSON text          -> JSON parsed -> returns { nodeId, changes }
//   2. empty text          -> returns { result: "" }                  (graceful fallback)
//   3. fenced JSON         -> stripCodeFences -> returns { nodeId, changes }
//   4. non-JSON prose      -> returns { result: "Edit complete." }
//   5. dispatch is invoked with the validated input object + default agentUrl + 300s

// No `@/lib/drupal-api` mock: the handlers graph carries no host-internal
// import since the instance-admin deps cutover (cinatra#172 Stage H2) — the
// deps stub below is the only seam.
vi.mock("../lib/drupal-mcp-client", () => ({
  callDrupalMcp: vi.fn(),
}));

import { createDrupalPrimitiveHandlers } from "@cinatra-ai/drupal-mcp-connector/mcp-handlers";
import {
  registerDrupalConnector,
  _resetDrupalDepsForTests,
} from "../deps";

const dispatchMock = vi.fn(
  async (_input: { agentUrl: string; payload: unknown; timeoutMs: number }) => "",
);

function registerDepsStub() {
  registerDrupalConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: dispatchMock,
    buildNangoBearerHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
    // External-MCP toolbox surfaces (unused by this suite's code paths).
    listMcpInstances: () => [],
    probeMcp: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl.replace(/\/+$/, "") + "/_mcp_tools",
    isPrivateUrl: () => false,
    isNangoConfigured: () => true,
    // Instance-admin surfaces (cinatra#172 Stage H2; unused by this suite).
    getApiStatus: vi.fn(async () => ({ instanceCount: 0, instances: [] })),
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: vi.fn(async () => []),
    // cinatra#409 — write-authority gate (unused by this suite; allow stub).
    requireInstanceWriteAuthority: vi.fn(async () => {}),
  });
}

describe("drupal_content_editor_run - reply-text handling", () => {
  let handlers: ReturnType<typeof createDrupalPrimitiveHandlers>;

  beforeEach(() => {
    handlers = createDrupalPrimitiveHandlers();
    dispatchMock.mockReset();
    registerDepsStub();
  });

  afterEach(() => {
    _resetDrupalDepsForTests();
  });

  it("Test 1: JSON reply text returns parsed JSON envelope", async () => {
    dispatchMock.mockResolvedValue(
      '{"nodeId":"24","changes":[{"field":"title","before":"old","after":"new"}]}',
    );
    const result = await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: { instanceId: "site-1", nodeId: "24", instructions: "Update title" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({
      nodeId: "24",
      changes: [{ field: "title", before: "old", after: "new" }],
    });
  });

  it("Test 2: empty reply text -> graceful fallback { result: '' }", async () => {
    dispatchMock.mockResolvedValue("");
    const result = await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: { instanceId: "site-1", nodeId: "24", instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ result: "" });
  });

  it("Test 3: code-fenced JSON -> stripCodeFences + parse OK", async () => {
    dispatchMock.mockResolvedValue('```json\n{"nodeId":"24","changes":[]}\n```');
    const result = await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: { instanceId: "site-1", nodeId: "24", instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ nodeId: "24", changes: [] });
  });

  it("Test 4: non-JSON prose -> returns { result: <text> }", async () => {
    dispatchMock.mockResolvedValue("Edit complete.");
    const result = await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: { instanceId: "site-1", nodeId: "24", instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toEqual({ result: "Edit complete." });
  });

  it("Test 5: dispatches the validated input object with the default agentUrl + 300s budget", async () => {
    dispatchMock.mockResolvedValue('{"nodeId":"42","changes":[]}');
    await (handlers as any).drupal_content_editor_run({
      primitiveName: "drupal_content_editor_run",
      input: { instanceId: "site-1", nodeId: "42", instructions: "x" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0][0] as {
      agentUrl: string;
      payload: { instanceId: string; nodeId: string };
      timeoutMs: number;
    };
    expect(arg.agentUrl).toBe("http://localhost:3010/agents/cinatra-ai/drupal-agent");
    expect(arg.timeoutMs).toBe(300_000);
    expect(arg.payload.instanceId).toBe("site-1");
    expect(arg.payload.nodeId).toBe("42");
  });
});
