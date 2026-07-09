// cinatra#1214 S4 (Drupal half) — in-admin MCP-only egress wiring guard.
//
// The house rule (#1214 / epic #1037): an in-admin CMS assistant reaches the CMS
// ONLY through that CMS's MCP integration — never a direct REST / JSON:API fetch
// with a stored credential. For Drupal the one remaining direct read
// (`drupal_node_get` → a `/jsonapi/*` fetch) was inverted to an MCP-primary read
// via `callDrupalMcp` (S2). This fast, Docker-free guard asserts that reroute at
// TWO layers so it cannot silently regress:
//
//   (A) BEHAVIOR — `drupal_node_get` invokes the MCP client (`callDrupalMcp`)
//       and makes ZERO `globalThis.fetch` calls on the read path.
//   (B) STATIC   — the handler source references no direct-REST egress at all
//       (`fetch(` / a `/jsonapi` URL path / the deleted JSON:API helpers).
//
// This is the connector-repo D2 sibling of the shared wire-capture guard (D1):
// D1 proves absence on the network wire; this proves absence in the code path,
// so the direct-REST read cannot be re-imported onto the in-admin path.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/drupal-mcp-client", () => ({
  callDrupalMcp: vi.fn(),
}));

import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "@cinatra-ai/drupal-mcp-connector/mcp-handlers";
import { registerDrupalConnector, _resetDrupalDepsForTests } from "../deps";

const listMcpInstancesMock = vi.fn((): any[] => []);

function registerDepsStub() {
  registerDrupalConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: vi.fn(async () => ""),
    buildNangoBearerHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
    listMcpInstances: listMcpInstancesMock,
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

const inst = (id = "site-1") => ({
  id,
  name: "Site 1",
  siteUrl: "http://localhost:8082",
  nangoConnectionId: id,
  providerConfigKey: "cinatra-drupal",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

// ---------------------------------------------------------------------------
// (A) Behavioral guard — the in-admin read primitive calls the MCP client and
//     makes no direct fetch.
// ---------------------------------------------------------------------------
describe("in-admin egress guard — behavior", () => {
  let handlers: ReturnType<typeof createDrupalPrimitiveHandlers>;
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers = createDrupalPrimitiveHandlers();
    listMcpInstancesMock.mockReset().mockReturnValue([inst("site-1")]);
    vi.mocked(callDrupalMcp).mockReset();
    // A real fetch on the read path is the violation this guard catches; spy so
    // any call is observable (and returns a shape the handler would choke on,
    // proving the read does NOT depend on it).
    fetchSpy = vi.fn(async () => {
      throw new Error("direct fetch is forbidden on the in-admin read path");
    });
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    registerDepsStub();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetDrupalDepsForTests();
  });

  it("drupal_node_get reads through callDrupalMcp (mcp_jsonapi_list_entities), never a direct fetch", async () => {
    vi.mocked(callDrupalMcp).mockResolvedValue({
      items: [
        {
          entity_type: "node",
          bundle: "article",
          id: 1,
          uuid: "u-1",
          label: "T",
          status: true,
          fields: { title: "T", body: "<p>b</p>", nid: 1 },
        },
      ],
      total: 1,
    });

    const result = (await (handlers as any).drupal_node_get({
      primitiveName: "drupal_node_get",
      input: { instanceId: "site-1", nodeId: "1" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    })) as any;

    // The MCP client IS the read transport.
    expect(callDrupalMcp).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-1" }),
      "mcp_jsonapi_list_entities",
      expect.objectContaining({ entity_type: "node", filters: { nid: 1 }, limit: 1 }),
    );
    // ZERO direct-REST egress on the read path.
    expect(fetchSpy).not.toHaveBeenCalled();
    // And the full-body before-value arrived over MCP.
    expect(result.body).toBe("<p>b</p>");
  });

  it("drupal_node_get never touches fetch even when it falls back to the summary tool", async () => {
    // Primary MCP read throws (jsonapi submodule unavailable) → summary fallback,
    // which is STILL the MCP client, never a fetch.
    vi.mocked(callDrupalMcp).mockImplementation(async (_i, tool) => {
      if (tool === "mcp_jsonapi_list_entities") throw new Error("unavailable");
      if (tool === "mcp_tools_get_recent_content") return { content: [{ id: "1", title: "T" }] };
      throw new Error("unexpected tool " + tool);
    });

    await (handlers as any).drupal_node_get({
      primitiveName: "drupal_node_get",
      input: { instanceId: "site-1", nodeId: "1" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    // Both hops went through the MCP client.
    expect(callDrupalMcp).toHaveBeenCalledWith(expect.anything(), "mcp_jsonapi_list_entities", expect.anything());
    expect(callDrupalMcp).toHaveBeenCalledWith(expect.anything(), "mcp_tools_get_recent_content", expect.anything());
  });
});

// ---------------------------------------------------------------------------
// (B) Static guard — the handler SOURCE carries no direct-REST egress.
// ---------------------------------------------------------------------------
describe("in-admin egress guard — static source", () => {
  // The real handler source (not the module graph).
  const source = readFileSync(new URL("../mcp/handlers.ts", import.meta.url), "utf8");

  // Strip comments so intentional prose that names the forbidden tokens (e.g.
  // "no direct /jsonapi/* fetch() egress") does not trip the guard; only CODE is
  // asserted. Block comments first, then line comments (the `//.*` strip also
  // clips the tail of the lone http:// default-URL string — harmless, it carries
  // none of the forbidden tokens).
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("makes no direct fetch() call in the handler code path", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("references no /jsonapi REST path in code (the MCP tool name mcp_jsonapi_* is not a path)", () => {
    // A leading-slash JSON:API path — the direct-REST egress that was deleted.
    // The MCP read tool `mcp_jsonapi_list_entities` uses `_jsonapi`, not `/jsonapi`.
    expect(code).not.toMatch(/\/jsonapi/);
  });

  it("does not reference the deleted direct-REST JSON:API helpers", () => {
    for (const deleted of ["readNodeViaJsonApi", "jsonApiGet", "flattenJsonApiNode", "JsonApiResource"]) {
      expect(code).not.toContain(deleted);
    }
  });

  it("routes the in-admin read through the MCP client (positive control)", () => {
    // The read primitive binds the MCP read tool and the MCP client.
    expect(code).toContain("mcp_jsonapi_list_entities");
    expect(code).toContain("callDrupalMcp");
    expect(code).toContain("readNodeViaMcp");
  });
});
