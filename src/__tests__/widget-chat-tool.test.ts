import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// createDrupalWidgetChatTool factory tests.
//
// Behavior contract:
//   D1: Returned LlmFunctionTool has the expected shape — name, required, description.
//   D2: Security override — LLM-supplied instanceId/nodeId are dropped; context wins.
//   D3: instructions string is passed through unchanged.
//   D4: Missing context fields default to "" (no undefined leakage).
//   D5: Handler return shape { nodeId, changes } passes back from execute() unchanged.
//
// The underlying drupal_content_editor_run handler dispatches over the
// host-bound `deps.dispatchContentEditor` seam (which returns the agent's reply
// TEXT). We register a deps stub and inspect the dispatched `payload` JSON to
// assert the security overrides.

vi.mock("@/lib/drupal-api", () => ({
  listDrupalInstances: vi.fn(async () => [
    {
      id: "site-1",
      name: "Site 1",
      siteUrl: "http://localhost:8082",
      mcpApiKey: "k",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ]),
  getDrupalAPIStatus: vi.fn(),
}));
vi.mock("../lib/drupal-mcp-client", () => ({ callDrupalMcp: vi.fn() }));

import { createDrupalWidgetChatTool } from "../widget-chat-tool";
import {
  registerDrupalConnector,
  _resetDrupalDepsForTests,
} from "../deps";

const dispatchMock = vi.fn(
  async (_input: { agentUrl: string; payload: string; timeoutMs: number }) => "",
);

function extractDispatchedInput(dispatchArg: any): Record<string, unknown> {
  // dispatchContentEditor receives { agentUrl, payload, timeoutMs } where
  // payload is the serialized input envelope. Extract and JSON.parse.
  return JSON.parse(dispatchArg?.payload ?? "");
}

describe("createDrupalWidgetChatTool", () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue(
      '{"nodeId":"24","changes":[{"field":"title","before":"a","after":"b"}]}',
    );
    registerDrupalConnector({
      decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
      buildListPage: (items, total, offset, limit) => ({
        items,
        total,
        nextCursor: offset + limit < total ? String(offset + limit) : undefined,
      }),
      dispatchContentEditor: dispatchMock,
      buildNangoBearerHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
    });
  });

  afterEach(() => {
    _resetDrupalDepsForTests();
  });

  it("D1: returns an LlmFunctionTool with the expected shape", () => {
    const tool = createDrupalWidgetChatTool({ context: { instanceId: "site-1", nodeId: "42" } });
    expect(tool.name).toBe("drupal_content_editor_run");
    expect(tool.parameters.required).toEqual(["instructions"]);
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toMatch(/nodeId/);
    expect(tool.description).toMatch(/changes/);
  });

  it("D2: forcibly overrides LLM-supplied instanceId and nodeId with context values", async () => {
    const tool = createDrupalWidgetChatTool({
      context: { instanceId: "site-1", nodeId: "42", nodeBundle: "article", nodeStatus: "published" },
    });
    await tool.execute({ instanceId: "ATTACKER", nodeId: "EVIL", instructions: "rename it" });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatched = extractDispatchedInput(dispatchMock.mock.calls[0][0]);
    expect(dispatched.instanceId).toBe("site-1");
    expect(dispatched.nodeId).toBe("42");
    expect(dispatched.instanceId).not.toBe("ATTACKER");
    expect(dispatched.nodeId).not.toBe("EVIL");
  });

  it("D3: forwards the user instructions unchanged to the handler", async () => {
    const tool = createDrupalWidgetChatTool({ context: { instanceId: "site-1", nodeId: "42" } });
    await tool.execute({ instructions: "change title to X" });
    const dispatched = extractDispatchedInput(dispatchMock.mock.calls[0][0]);
    expect(dispatched.instructions).toBe("change title to X");
  });

  it("D4: defaults missing context fields to empty strings (no undefined leakage)", async () => {
    // The Drupal handler's zod schema requires instanceId.min(1) and nodeId.min(1).
    // When context is {} the wrapper produces input { instanceId: "", nodeId: "", ... }
    // — non-undefined empty strings. zod rejects with a "min(1)" message (distinct from
    // a "required" / "expected string, received undefined" message) which proves the
    // override layer installed string defaults rather than letting undefined leak.
    const tool = createDrupalWidgetChatTool({ context: {} });
    let caught: unknown = null;
    try {
      await tool.execute({ instructions: "x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // The wrapper MUST NOT have dispatched — zod fails at the handler boundary first.
    expect(dispatchMock).not.toHaveBeenCalled();
    // Distinguish a "string of length 0" error (which proves an empty STRING was
    // passed — i.e. the override layer worked) from a "received undefined" /
    // "invalid_type" error (which would mean undefined leaked through).
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message.toLowerCase()).not.toMatch(/received undefined/);
    expect(message.toLowerCase()).not.toMatch(/invalid_type/);
    // Positive evidence: zod's "too_small" / ">=1 characters" indicates the
    // value was a string of length 0, exactly what `String(undefined ?? "")` produces.
    expect(message.toLowerCase()).toMatch(/too_small|>=1 characters|too small/);
  });

  it("D5: returns the handler result unchanged", async () => {
    const tool = createDrupalWidgetChatTool({ context: { instanceId: "site-1", nodeId: "42" } });
    const result = (await tool.execute({ instructions: "x" })) as { nodeId: string; changes: unknown[] };
    expect(result.nodeId).toBe("24");
    expect(result.changes).toEqual([{ field: "title", before: "a", after: "b" }]);
  });
});
