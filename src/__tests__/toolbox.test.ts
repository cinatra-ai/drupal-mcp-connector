// Verifies the first-party Drupal external-MCP toolbox (manifest-discovered
// builder). Relocated from the host's drupal-mcp-connection builder test when
// the builder moved into this extension; instance settings, the probe, the
// endpoint resolution, and the Nango bearer come through the host-bound deps
// (wired in src/lib/register-transport-connectors.ts; stubbed here).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { registerDrupalConnector, _resetDrupalDepsForTests, type DrupalMcpInstance } from "../deps";
import { createDrupalExternalMcpToolbox } from "../mcp/toolbox";

const listMcpInstances = vi.fn<() => DrupalMcpInstance[]>(() => []);
const probeMcp = vi.fn();
const buildNangoBearerHeader = vi.fn();
const isNangoConfigured = vi.fn();

const inst = (id: string, siteUrl?: string): DrupalMcpInstance => ({
  id,
  name: `Site ${id}`,
  siteUrl: siteUrl ?? `https://site-${id}.example.com`,
  nangoConnectionId: id,
  providerConfigKey: "cinatra-drupal",
});

beforeEach(() => {
  vi.clearAllMocks();
  isNangoConfigured.mockReturnValue(true);
  probeMcp.mockResolvedValue("registered");
  buildNangoBearerHeader.mockResolvedValue({ Authorization: "Bearer default-token" });
  registerDrupalConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: vi.fn(async () => ""),
    buildNangoBearerHeader,
    listMcpInstances,
    probeMcp,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl.replace(/\/+$/, "") + "/_mcp_tools",
    isPrivateUrl: (url: string) => /localhost|127\.0\.0\.1|::1/.test(url),
    isNangoConfigured,
    // Instance-admin surfaces (cinatra#172 Stage H2; unused by this suite).
    getApiStatus: vi.fn(async () => ({ instanceCount: 0, instances: [] })),
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: vi.fn(async () => []),
  });
});

afterEach(() => {
  _resetDrupalDepsForTests();
});

describe("createDrupalExternalMcpToolbox().buildTools", () => {
  it("returns [] when Nango is unconfigured and warns once", async () => {
    isNangoConfigured.mockReturnValue(false);
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createDrupalExternalMcpToolbox().buildTools("openai");

    expect(result).toEqual([]);
    expect(buildNangoBearerHeader).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] when no instances configured", async () => {
    listMcpInstances.mockReturnValue([]);
    expect(await createDrupalExternalMcpToolbox().buildTools("openai")).toEqual([]);
  });

  it("skips private URLs (localhost) — never returned to LLM", async () => {
    listMcpInstances.mockReturnValue([inst("a", "http://localhost:8082")]);
    expect(await createDrupalExternalMcpToolbox().buildTools("openai")).toEqual([]);
    // No Nango lookup for private rows — they're skipped first.
    expect(buildNangoBearerHeader).not.toHaveBeenCalled();
  });

  it("emits one MCP server tool per instance with Nango-backed Authorization header", async () => {
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    buildNangoBearerHeader
      .mockResolvedValueOnce({ Authorization: "Bearer token-a" })
      .mockResolvedValueOnce({ Authorization: "Bearer token-b" });

    const result = await createDrupalExternalMcpToolbox().buildTools("openai");

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: "mcp",
      serverLabel: "drupal-a",
      serverUrl: "https://site-a.example.com/_mcp_tools",
      headers: { Authorization: "Bearer token-a" },
    });
    expect(result[1]).toMatchObject({
      type: "mcp",
      serverLabel: "drupal-b",
      headers: { Authorization: "Bearer token-b" },
    });
    expect(buildNangoBearerHeader).toHaveBeenCalledTimes(2);
    expect(buildNangoBearerHeader).toHaveBeenCalledWith({
      providerConfigKey: "cinatra-drupal",
      connectionId: "a",
      label: "drupal-a",
    });
  });

  it("skips instances where Nango header lookup returns null", async () => {
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    buildNangoBearerHeader
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Authorization: "Bearer token-b" });

    const result = await createDrupalExternalMcpToolbox().buildTools("openai");

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("drupal-b");
  });

  it("skips instances whose probe is not 'registered'", async () => {
    listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
    probeMcp.mockResolvedValueOnce("auth_error").mockResolvedValueOnce("registered");

    const result = await createDrupalExternalMcpToolbox().buildTools("openai");

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("drupal-b");
  });

  it("returns [] and never throws when deps are unavailable", async () => {
    _resetDrupalDepsForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createDrupalExternalMcpToolbox().buildTools("openai");

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
