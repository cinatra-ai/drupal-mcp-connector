import { describe, expect, it } from "vitest";

import { registerDrupalPrimitives } from "../mcp/registry";

// cinatra#246 regression guard. The content-editor RELAY (`drupal_content_editor_run`)
// must NOT be registered as a self-MCP tool: when the drupal-content-editor
// agent has the cinatra MCP server injected, a visible dispatcher tool let the
// model call it and re-dispatch itself (observed recursive mcp_call -> 504).
// The host relays to the agent directly via dispatchContentEditorViaA2A; the
// relay handler still exists in the map but must never reach tools/list.
describe("registerDrupalPrimitives — relay is NOT a model-visible MCP tool (cinatra#246)", () => {
  it("registers the real read/write primitives but OMITS drupal_content_editor_run", () => {
    const registered: string[] = [];
    const server = {
      registerTool: (name: string) => {
        registered.push(name);
      },
    } as unknown as Parameters<typeof registerDrupalPrimitives>[0];

    registerDrupalPrimitives(server);

    // Real CMS primitives the SKILL.md names are present...
    expect(registered).toContain("drupal_node_get");
    expect(registered).toContain("drupal_node_update");
    // ...but the dispatcher relay is excluded from the MCP surface.
    expect(registered).not.toContain("drupal_content_editor_run");
  });
});
