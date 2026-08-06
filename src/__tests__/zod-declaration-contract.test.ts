import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { registerDrupalPrimitives } from "../mcp/registry";

// #83. `zod` is a DECLARED dependency of this package, at `^4.4.3`. Two things
// about that are load-bearing, and neither is visible from the source alone:
//
//   1. THE FLOORS ARE REAL, AND THERE ARE TWO. Measured across zod 3.25.76 /
//      4.0.0 / 4.1.12 / 4.2.0 / 4.4.3. At RUNTIME the floor is major 4: against
//      a real `@modelcontextprotocol/server@2.0.0` a zod 3.x schema REGISTERS
//      CLEANLY and then fails the ENTIRE `tools/list` with JSON-RPC -32603
//      ("Schema appears to be from zod 3, which the SDK cannot convert to JSON
//      Schema") — one bad schema takes out the whole tool surface, not just its
//      own tool. At COMPILE time the floor is 4.2, where zod first exposes the
//      `~standard.jsonSchema` that the host's `ExtensionStandardSchema` requires;
//      on 4.0/4.1 `../mcp/registry` stops typechecking (TS2322). The host tree
//      really does carry a zod 3.x copy alongside the 4.x one (pulled
//      transitively), so this is reachable rather than hypothetical.
//   2. THE RANGE TRACKS THE HOST. `^4.4.3` is the cinatra host's own range,
//      character for character, and what every sibling extension declaring `zod`
//      uses. That is a coordination convention, not a correctness cliff — the
//      host consumes these schemas structurally through `~standard`, never via
//      `instanceof`, so a second compatible zod 4.x instance would still work.
//      What it buys is that a full resolution typically converges the connector
//      and the host on one instance rather than installing a second copy, and
//      that a host bump inside major 4 carries this package along instead of
//      stranding it.
//
// The first is proved below against a REAL server rather than by inspecting
// object shapes; the second is a manifest rule, so it is asserted on the
// manifest.

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

describe("zod is declared, at the host's exact range (#83)", () => {
  it("declares zod in dependencies — not devDependencies, not undeclared", () => {
    // Undeclared means resolving through the host's hoisted root symlink, which
    // pnpm publishes only for a direct dependency of the ROOT importer: the
    // phantom edge this test exists to keep closed. devDependencies would be
    // wrong too — `src/` ships in the published `files` payload and all three
    // importing modules are package entry points.
    expect(manifest.dependencies?.zod).toBeDefined();
    expect(manifest.devDependencies?.zod).toBeUndefined();
  });

  it("pins the declared range to a reviewed literal", () => {
    // Exact equality on purpose: a looser assertion would admit `^4.0.0` (which
    // runs, but stops `../mcp/registry` typechecking against the host's
    // `ExtensionStandardSchema`) and unions like `^4.4.3 || ^3.25.76` (which
    // re-admit the 3.x copy already in the host tree, the one that kills
    // `tools/list` outright).
    //
    // Be clear about what this does NOT do: it is a tripwire, not a live check
    // of the host. It cannot tell whether the cinatra root still declares
    // `^4.4.3` — this package's suite has no business reading the host's
    // manifest — so it will not fire when the host moves away and this line
    // stays put. What it guarantees is the weaker, still useful thing: this
    // range cannot be edited incidentally. Changing it is a deliberate act that
    // updates this line too, which is where the host reconciliation gets
    // remembered. The floor itself is enforced separately below, against the
    // version that actually resolved.
    expect(manifest.dependencies?.zod).toBe("^4.4.3");
  });

  it("resolves a zod that clears BOTH floors — major 4 at runtime, 4.2 for the type contract", () => {
    // The semantic half of the rule, asserted on the RESOLVED library rather
    // than on a manifest string: a range can be right while the tree hands the
    // package something else (an override, a stale hoist, a bad resolution).
    //
    // The 4.2 half is deliberately checked here rather than left to `tsc`. Only
    // the monorepo typechecks this package — this repo's own CI skips it for
    // source mirrors — so without this assertion a 4.0/4.1 resolution would
    // reach a tree where nothing in THIS suite notices.
    const { major, minor } = z.core.version;
    expect(major).toBeGreaterThanOrEqual(4);
    if (major === 4) expect(minor).toBeGreaterThanOrEqual(2);
  });
});

describe("the real MCP server accepts every advertised schema and publishes it (#83)", () => {
  const registerAll = (srv: McpServer) => {
    const names: string[] = [];
    const server = {
      registerTool: (name: string, config: unknown, handler: unknown) => {
        names.push(name);
        (srv.registerTool as (...a: unknown[]) => unknown)(name, config, handler);
      },
    } as unknown as Parameters<typeof registerDrupalPrimitives>[0];
    registerDrupalPrimitives(server);
    return names;
  };

  const toolsList = async (srv: McpServer) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await srv.connect(transport);
    try {
      const res = await transport.handleRequest(
        new Request("https://cinatra.test/api/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
      );
      return (await res.json()) as {
        error?: { code?: number; message?: string };
        result?: { tools?: { name: string; inputSchema?: Record<string, unknown> }[] };
      };
    } finally {
      // Closed on the failure path too, so a throw here cannot leak the
      // transport into the next test.
      await transport.close();
    }
  };

  it("tools/list succeeds — no conversion error takes the surface down", async () => {
    // The failure this guards is not local to one tool: a schema the SDK cannot
    // convert registers without throwing, so nothing at the call site can catch
    // it, and the error surfaces only when the list is first served — for EVERY
    // tool at once.
    const srv = new McpServer({ name: "drupal-mcp-connector-test", version: "0.0.0" });
    const registered = registerAll(srv);
    expect(registered).toContain("drupal_node_get");

    const body = await toolsList(srv);

    expect(body.error).toBeUndefined();
    expect(body.result?.tools?.map((t) => t.name).sort()).toEqual([...registered].sort());
  });

  it("every published tool carries a converted JSON Schema, with real argument shapes", async () => {
    const srv = new McpServer({ name: "drupal-mcp-connector-test", version: "0.0.0" });
    registerAll(srv);

    const tools = (await toolsList(srv)).result?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} published no inputSchema`).toBeDefined();
      expect(tool.inputSchema?.type, `${tool.name} inputSchema is not an object schema`).toBe(
        "object",
      );
    }

    // Spot-check one tool end-to-end: the properties the connector declared are
    // the properties the wire advertises. A converter that merely ran would pass
    // the loop above; this asserts it converted THIS schema.
    const nodeGet = tools.find((t) => t.name === "drupal_node_get");
    expect(Object.keys((nodeGet?.inputSchema?.properties as object) ?? {}).sort()).toEqual([
      "instanceId",
      "nodeId",
    ]);
    expect((nodeGet?.inputSchema?.required as string[])?.sort()).toEqual([
      "instanceId",
      "nodeId",
    ]);
  });
});
