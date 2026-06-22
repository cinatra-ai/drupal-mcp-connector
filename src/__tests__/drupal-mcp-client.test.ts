// callDrupalMcp resolves the Bearer token from the Nango vault via the
// host-bound `deps.buildNangoBearerHeader` seam instead of reading
// instance.mcpApiKey (which does not exist on the type) — the connector no
// longer imports @cinatra-ai/nango-connector directly.
//
// Tests preserve behavior coverage for URL shape, response unwrap, and
// error envelopes. They also cover missing-credential errors, happy-path
// headers from the deps seam instead of the row, and preventing token leakage
// in error messages.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  registerDrupalConnector,
  _resetDrupalDepsForTests,
} from "../deps";

const mockConnect = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // Regular function required — arrow functions cannot be used with `new`.
  Client: vi.fn().mockImplementation(function () {
    return { connect: mockConnect, callTool: mockCallTool, close: mockClose };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function () { return {}; }),
}));

import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The host-bound Nango bearer-header builder (deps.buildNangoBearerHeader).
const buildNangoBearerHeader = vi.fn();

const inst = (over: Partial<{ id: string; name: string; siteUrl: string; nangoConnectionId: string; providerConfigKey: string }> = {}) => ({
  id: over.id ?? "1",
  name: over.name ?? "x",
  siteUrl: over.siteUrl ?? "http://localhost:8082",
  nangoConnectionId: over.nangoConnectionId ?? over.id ?? "1",
  providerConfigKey: over.providerConfigKey ?? "cinatra-drupal",
  createdAt: "",
  updatedAt: "",
});

describe("callDrupalMcp", () => {
  beforeEach(() => {
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockCallTool.mockReset();
    mockClose.mockReset().mockResolvedValue(undefined);
    vi.mocked(StreamableHTTPClientTransport).mockClear();
    buildNangoBearerHeader.mockReset();
    // Default Nango success — individual tests override for credential-specific cases.
    buildNangoBearerHeader.mockResolvedValue({
      Authorization: "Bearer nango-resolved-token",
    });
    registerDrupalConnector({
      decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
      buildListPage: (items, total, offset, limit) => ({
        items,
        total,
        nextCursor: offset + limit < total ? String(offset + limit) : undefined,
      }),
      dispatchContentEditor: vi.fn(async () => ""),
      buildNangoBearerHeader,
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
  });

  afterEach(() => {
    _resetDrupalDepsForTests();
  });

  it("appends /_mcp_tools to the configured siteUrl and uses StreamableHTTPClientTransport", async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: '{"ok":true}' }] });
    await callDrupalMcp(inst(), "mcp_tools_search_content", { query: "test" });
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    expect(String(url)).toBe("http://localhost:8082/_mcp_tools");
  });

  it("resolves Bearer header from Nango using instance.nangoConnectionId + providerConfigKey, NOT from the row", async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: '"ok"' }] });
    await callDrupalMcp(
      inst({ id: "1", siteUrl: "https://example.com/", nangoConnectionId: "1", providerConfigKey: "cinatra-drupal" }),
      "mcp_tools_search_content",
      { query: "hello" },
    );
    expect(buildNangoBearerHeader).toHaveBeenCalledWith({
      providerConfigKey: "cinatra-drupal",
      connectionId: "1",
      label: "drupal-1",
    });
    const [, opts] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    expect(opts).toMatchObject({ requestInit: { headers: { Authorization: "Bearer nango-resolved-token" } } });
  });

  it("throws a clear, label-only error when Nango credential is unavailable (no token in message)", async () => {
    buildNangoBearerHeader.mockResolvedValueOnce(null);
    await expect(
      callDrupalMcp(inst({ siteUrl: "https://example.com" }), "mcp_tools_search_content", { query: "x" }),
    ).rejects.toThrow(/Drupal MCP call failed: credential unavailable for site https:\/\/example.com/);
    expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
  });

  it("calls client.callTool with { name, arguments } and returns parsed JSON when text is JSON", async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: '{"id":"5","title":"Hello"}' }] });
    const result = await callDrupalMcp(inst(), "mcp_tools_search_content", { query: "Hello" });
    expect(mockCallTool).toHaveBeenCalledWith({ name: "mcp_tools_search_content", arguments: { query: "Hello" } });
    expect(result).toEqual({ id: "5", title: "Hello" });
  });

  it("falls back to raw string when text is not JSON (mcp_tools may return plain text)", async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "node-published" }] });
    const result = await callDrupalMcp(inst(), "mcp_publish_content", { nid: 5 });
    expect(result).toBe("node-published");
  });

  it("strips trailing slashes from siteUrl before appending /_mcp_tools", async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    await callDrupalMcp(inst({ siteUrl: "https://example.com///" }), "mcp_tools_search_content", { query: "x" });
    const [url] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    expect(String(url)).toBe("https://example.com/_mcp_tools");
  });

  it("throws when content array contains no text item", async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: "image", url: "..." }] });
    await expect(
      callDrupalMcp(inst(), "mcp_tools_search_content", { query: "x" }),
    ).rejects.toThrow(/Drupal mcp_tools_search_content/);
  });

  it("calls client.close in finally even when callTool throws", async () => {
    mockCallTool.mockRejectedValue(new Error("network"));
    await expect(
      callDrupalMcp(inst(), "mcp_tools_search_content", { query: "x" }),
    ).rejects.toThrow();
    expect(mockClose).toHaveBeenCalled();
  });

  it("prefers structuredContent over text and unwraps data envelope", async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: 'Success.\n{"success":true,"message":"ok","data":{"id":"5"}}' }],
      structuredContent: { success: true, message: "ok", data: { id: "5", title: "Hello" } },
    });
    const result = await callDrupalMcp(inst(), "mcp_tools_get_recent_content", {});
    expect(result).toEqual({ id: "5", title: "Hello" });
  });

  it("throws when structuredContent signals success:false", async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "Permission denied" }],
      structuredContent: { success: false, message: "Permission denied" },
    });
    await expect(
      callDrupalMcp(inst(), "mcp_tools_get_recent_content", {}),
    ).rejects.toThrow(/Permission denied/);
  });

  it("throws when structuredContent has data:null", async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: 'Success.\n{"success":true,"data":null}' }],
      structuredContent: { success: true, message: "ok", data: null },
    });
    await expect(
      callDrupalMcp(inst(), "mcp_tools_get_recent_content", {}),
    ).rejects.toThrow(/null data/);
  });

  it("strips Success prefix from text fallback and unwraps data envelope", async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: 'Success.\n{"success":true,"message":"ok","data":{"id":"5"}}' }],
    });
    const result = await callDrupalMcp(inst(), "mcp_tools_get_recent_content", {});
    expect(result).toEqual({ id: "5" });
  });
});
