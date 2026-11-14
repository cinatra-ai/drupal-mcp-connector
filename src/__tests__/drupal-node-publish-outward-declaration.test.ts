import { describe, it, expect } from "vitest";

import { registerDrupalPrimitives } from "../mcp/registry";

// cinatra#3745: a tool that publishes on a person's behalf declares `outward` on
// its registration, so the host holds each call of it in an agent run for the
// person's recorded decision. `drupal_node_publish` takes a node id and no stored item with a revision, so its declaration names no
// subject: it is exactly `{}`. No other tool of this connector acts outward,
// and none declares it.
describe("drupal_node_publish declares that it acts outward (cinatra#3745)", () => {
  function registeredConfigs(): Map<string, Record<string, unknown>> {
    const configs = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool: (name: string, config: Record<string, unknown>) => {
        configs.set(name, config);
      },
    } as unknown as Parameters<typeof registerDrupalPrimitives>[0];
    registerDrupalPrimitives(server);
    return configs;
  }

  it("registers drupal_node_publish with outward: {}", () => {
    const config = registeredConfigs().get("drupal_node_publish");
    expect(config).toBeDefined();
    expect("outward" in config!).toBe(true);
    expect(config!.outward).toEqual({});
  });

  it("declares outward on drupal_node_publish only", () => {
    const declared = [...registeredConfigs()]
      .filter(([, config]) => "outward" in config)
      .map(([name]) => name);
    expect(declared).toEqual(["drupal_node_publish"]);
  });
});
