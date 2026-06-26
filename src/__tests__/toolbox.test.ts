// Verifies the first-party Drupal external-MCP toolbox (manifest-discovered
// builder). Relocated from the host's drupal-mcp-connection builder test when
// the builder moved into this extension; instance settings, the probe, the
// endpoint resolution, and the Nango bearer come through the host-bound deps
// (wired in src/lib/register-transport-connectors.ts; stubbed here).
//
// AUTHZ HARDENING — confused-deputy / cross-tenant authz bypass prevention.
// The toolbox MUST resolve instances through the ACTOR-SCOPED, fail-closed host
// dep `listAuthorizedMcpInstances` (the host returns only the trusted actor's
// org-entitled instances; an unresolved actor yields []), NEVER the global
// unscoped `listMcpInstances`. The tools it injects carry an explicit read+write
// allowlist and `requireApproval: "always"`.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { registerDrupalConnector, _resetDrupalDepsForTests, type DrupalMcpInstance } from "../deps";
import { createDrupalExternalMcpToolbox } from "../mcp/toolbox";

// The GLOBAL unscoped lister — kept bound so we can ASSERT the toolbox never
// touches it (the cross-tenant confused-deputy path it must not take).
const listMcpInstances = vi.fn<() => DrupalMcpInstance[]>(() => []);
// The ACTOR-SCOPED, fail-closed lister. The host returns ONLY the trusted
// actor's org-entitled instances; [] for an unresolved/unauthorized actor.
const listAuthorizedMcpInstances = vi.fn<() => Promise<DrupalMcpInstance[]>>(async () => []);
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

function registerDeps(over?: { omitAuthorizedLister?: boolean; authorizedListerValue?: unknown }) {
  const deps: any = {
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items: any[], total: number, offset: number, limit: number) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: vi.fn(async () => ""),
    buildNangoBearerHeader,
    listMcpInstances,
    listAuthorizedMcpInstances,
    probeMcp,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl.replace(/\/+$/, "") + "/_mcp_tools",
    isPrivateUrl: (url: string) => /localhost|127\.0\.0\.1|::1/.test(url),
    isNangoConfigured,
    getApiStatus: vi.fn(async () => ({ instanceCount: 0, instances: [] })),
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: vi.fn(async () => []),
    requireInstanceWriteAuthority: vi.fn(async () => {}),
  };
  if (over?.omitAuthorizedLister) delete deps.listAuthorizedMcpInstances;
  if (over && "authorizedListerValue" in over) deps.listAuthorizedMcpInstances = over.authorizedListerValue;
  registerDrupalConnector(deps);
}

beforeEach(() => {
  vi.clearAllMocks();
  isNangoConfigured.mockReturnValue(true);
  probeMcp.mockResolvedValue("registered");
  buildNangoBearerHeader.mockResolvedValue({ Authorization: "Bearer default-token" });
  registerDeps();
});

afterEach(() => {
  _resetDrupalDepsForTests();
});

describe("createDrupalExternalMcpToolbox().buildTools", () => {
  it("returns [] when Nango is unconfigured and warns once", async () => {
    isNangoConfigured.mockReturnValue(false);
    listAuthorizedMcpInstances.mockResolvedValue([inst("a"), inst("b")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createDrupalExternalMcpToolbox().buildTools("openai");

    expect(result).toEqual([]);
    expect(buildNangoBearerHeader).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] when no authorized instances", async () => {
    listAuthorizedMcpInstances.mockResolvedValue([]);
    expect(await createDrupalExternalMcpToolbox().buildTools("openai")).toEqual([]);
  });

  it("skips private URLs (localhost) — never returned to LLM", async () => {
    listAuthorizedMcpInstances.mockResolvedValue([inst("a", "http://localhost:8082")]);
    expect(await createDrupalExternalMcpToolbox().buildTools("openai")).toEqual([]);
    // No Nango lookup for private rows — they're skipped first.
    expect(buildNangoBearerHeader).not.toHaveBeenCalled();
  });

  it("emits one MCP server tool per authorized instance with Nango-backed Authorization header", async () => {
    listAuthorizedMcpInstances.mockResolvedValue([inst("a"), inst("b")]);
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
    listAuthorizedMcpInstances.mockResolvedValue([inst("a"), inst("b")]);
    buildNangoBearerHeader
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Authorization: "Bearer token-b" });

    const result = await createDrupalExternalMcpToolbox().buildTools("openai");

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("drupal-b");
  });

  it("skips instances whose probe is not 'registered'", async () => {
    listAuthorizedMcpInstances.mockResolvedValue([inst("a"), inst("b")]);
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

  // -------------------------------------------------------------------------
  // confused-deputy / cross-tenant authz bypass prevention.
  // -------------------------------------------------------------------------
  describe("actor-scoped, fail-closed instance resolution", () => {
    it("NEGATIVE — foreign/unauthorized actor: host returns no authorized instances → ZERO tools, NO credential resolved", async () => {
      // The host's listAuthorizedMcpInstances has resolved the trusted actor and
      // found the actor's org is entitled to NONE of the configured Drupal
      // instances (foreign-org actor / unresolved actor → fail-closed []).
      listAuthorizedMcpInstances.mockResolvedValue([]);
      // Other tenants' instances exist in the GLOBAL list — but the toolbox must
      // never reach for them.
      listMcpInstances.mockReturnValue([inst("foreign-a"), inst("foreign-b")]);

      const result = await createDrupalExternalMcpToolbox().buildTools("openai");

      expect(result).toEqual([]);
      // No cross-tenant credential is ever constructed for a non-entitled actor.
      expect(buildNangoBearerHeader).not.toHaveBeenCalled();
      expect(probeMcp).not.toHaveBeenCalled();
      // The toolbox NEVER consults the global unscoped lister.
      expect(listMcpInstances).not.toHaveBeenCalled();
    });

    it("NEGATIVE — fail-closed when the actor-scoped lister is UNBOUND on an old/skewed host (no fallback to the global list)", async () => {
      registerDeps({ omitAuthorizedLister: true });
      listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await createDrupalExternalMcpToolbox().buildTools("openai");

      expect(result).toEqual([]);
      // Must NOT fall back to the unscoped global list when authorization can't run.
      expect(listMcpInstances).not.toHaveBeenCalled();
      expect(buildNangoBearerHeader).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("NEGATIVE — fail-closed when the actor-scoped lister is bound to a non-function (skewed host)", async () => {
      registerDeps({ authorizedListerValue: "not-a-function" });
      listMcpInstances.mockReturnValue([inst("a")]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await createDrupalExternalMcpToolbox().buildTools("openai");

      expect(result).toEqual([]);
      expect(listMcpInstances).not.toHaveBeenCalled();
      expect(buildNangoBearerHeader).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("POSITIVE — authorized actor: only the actor's org-entitled instances are injected, never the global set", async () => {
      // Host resolved the trusted actor → entitled to site-a ONLY (site-b belongs
      // to another org and is filtered out host-side before any header is built).
      listAuthorizedMcpInstances.mockResolvedValue([inst("a")]);
      listMcpInstances.mockReturnValue([inst("a"), inst("b")]);
      buildNangoBearerHeader.mockResolvedValue({ Authorization: "Bearer token-a" });

      const result = await createDrupalExternalMcpToolbox().buildTools("openai");

      expect(result).toHaveLength(1);
      expect(result[0].serverLabel).toBe("drupal-a");
      // Only the entitled instance's credential was ever resolved.
      expect(buildNangoBearerHeader).toHaveBeenCalledTimes(1);
      expect(buildNangoBearerHeader).toHaveBeenCalledWith({
        providerConfigKey: "cinatra-drupal",
        connectionId: "a",
        label: "drupal-a",
      });
      // The global unscoped lister is never consulted on the injection path.
      expect(listMcpInstances).not.toHaveBeenCalled();
    });

    it("injected tools carry an explicit read+write allowlist and require approval (no allowedTools:null / requireApproval:never)", async () => {
      listAuthorizedMcpInstances.mockResolvedValue([inst("a")]);
      buildNangoBearerHeader.mockResolvedValue({ Authorization: "Bearer token-a" });

      const result = await createDrupalExternalMcpToolbox().buildTools("openai");

      expect(result).toHaveLength(1);
      const tool = result[0];
      // Explicit allowlist — never null (which exposes every present/future tool).
      expect(Array.isArray(tool.allowedTools)).toBe(true);
      expect(tool.allowedTools).toEqual(
        expect.arrayContaining([
          "mcp_tools_search_content",
          "mcp_tools_get_recent_content",
          "mcp_update_content",
          "mcp_create_content",
          "mcp_publish_content",
        ]),
      );
      // The state-mutating writes are never auto-approved.
      expect(tool.requireApproval).toBe("always");
      expect(tool.requireApproval).not.toBe("never");
    });
  });
});
