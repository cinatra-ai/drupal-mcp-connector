// The relocated Drupal instance-settings client (cinatra#975 Wave 3) — the
// core `src/lib/__tests__/drupal-api.test.ts` suite ported 1:1 onto the
// connector-owned client, with the host-module mocks replaced by injected
// capability fakes (connector-config KV / nango-system slice /
// instance-connection-gate slice / warn sink). Behavior byte-equivalence is the
// contract: every assertion below matches the core suite; the additions at the
// bottom cover the capability-boundary seams that replaced in-repo imports
// (trusted-session binding fold, warn routing).

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  buildDrupalInstanceClient,
  type DrupalConnectionGateSlice,
  type DrupalInstanceStoreDeps,
  type DrupalNangoSurfaceSlice,
} from "../lib/drupal-instances";

const KEY = "drush-generated-bearer-token-xyz123";

// ---------------------------------------------------------------------------
// Injected capability fakes (deterministic local store — the same semantics
// the core suite stubbed onto @/lib/database and @/lib/nango-system).
// ---------------------------------------------------------------------------

let CONFIG_STORE: Record<string, unknown> = {};

function makeHarness() {
  const read = vi.fn(<T,>(key: string, fallback: T): T => (CONFIG_STORE[key] as T) ?? fallback);
  const write = vi.fn((key: string, value: unknown) => {
    CONFIG_STORE[key] = value;
  });
  const nango = {
    isNangoConfigured: vi.fn(() => true),
    ensureNangoConnectorIntegration: vi.fn(async () => null),
    importNangoConnection: vi.fn(async () => null),
    getNangoCredentials: vi.fn(async () => null as unknown),
    deleteNangoConnection: vi.fn(async () => undefined),
    removeNangoConnectionRecord: vi.fn(async () => undefined),
    saveNangoConnectionRecord: vi.fn(async () => undefined),
    providerConfigKeys: { drupal: "cinatra-drupal" },
  };
  const gate = {
    // `{ gated: false }` == the host fold of "no identity resolved/seeded" —
    // the client falls through to the ungated readback exactly like the
    // pre-#967 behavior (the core suite's `null` return).
    enforceInstanceConnectionUse: vi.fn(async () => ({ gated: false })),
    // No session by default — the sanctioned fresh-binding source resolves null.
    resolveTrustedSessionBinding: vi.fn(async () => null as { orgId: string; runBy: string } | null),
  };
  const warn = vi.fn();
  const client = buildDrupalInstanceClient({
    connectorConfig: () =>
      ({ read, write }) as unknown as ReturnType<DrupalInstanceStoreDeps["connectorConfig"]>,
    nango: () => nango as unknown as DrupalNangoSurfaceSlice,
    connectionGate: () => gate as unknown as DrupalConnectionGateSlice,
    warn,
  });
  return { client, nango, gate, warn, read, write };
}

let h: ReturnType<typeof makeHarness>;

beforeEach(() => {
  CONFIG_STORE = {};
  vi.clearAllMocks();
  h = makeHarness();
});

describe("saveDrupalInstance credential persistence", () => {
  it("happy path: new instance — ensure → import (no connectorKey) → readback → persist → saveNangoConnectionRecord (in that order)", async () => {
    h.nango.getNangoCredentials.mockResolvedValueOnce({ apiKey: KEY } as never);

    const result = await h.client.saveDrupalInstance({
      name: "Site A",
      siteUrl: "https://a.example.com",
      mcpApiKey: KEY,
    });

    expect(h.nango.isNangoConfigured).toHaveBeenCalled();
    expect(h.nango.ensureNangoConnectorIntegration).toHaveBeenCalledWith("drupal");
    // importNangoConnection is called without connectorKey.
    const importArgs = (h.nango.importNangoConnection.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(importArgs.connectorKey).toBeUndefined();
    expect(importArgs.providerConfigKey).toBe("cinatra-drupal");
    expect(importArgs.connectionId).toBe(result.id); // UUID == connectionId
    expect(importArgs.credentials).toEqual({ type: "API_KEY", apiKey: KEY });
    expect(importArgs.metadata).toEqual({ siteUrl: "https://a.example.com" });
    // Readback forceRefresh
    expect(h.nango.getNangoCredentials).toHaveBeenCalledWith("cinatra-drupal", result.id, {
      forceRefresh: true,
    });
    // saveNangoConnectionRecord runs after readback.
    // Must pass { multiple: true } as the third arg because
    // importNangoConnection is called without connectorKey, bypassing
    // schema-driven multiple inference.
    expect(h.nango.saveNangoConnectionRecord).toHaveBeenCalledWith(
      "drupal",
      expect.objectContaining({
        connectionId: result.id,
        providerConfigKey: "cinatra-drupal",
        metadata: { siteUrl: "https://a.example.com" },
      }),
      { multiple: true },
    );
    // Row persisted without mcpApiKey, with the pointer fields.
    expect(result).toMatchObject({
      name: "Site A",
      siteUrl: "https://a.example.com",
      nangoConnectionId: result.id,
      providerConfigKey: "cinatra-drupal",
    });
    expect((result as Record<string, unknown>).mcpApiKey).toBeUndefined();
  });

  it("throws when Nango is unconfigured (no import / readback called)", async () => {
    h.nango.isNangoConfigured.mockReturnValue(false);

    await expect(
      h.client.saveDrupalInstance({ name: "Site A", siteUrl: "https://a.example.com", mcpApiKey: KEY }),
    ).rejects.toThrow(/Nango is not configured/);

    expect(h.nango.importNangoConnection).not.toHaveBeenCalled();
    expect(h.nango.getNangoCredentials).not.toHaveBeenCalled();
    expect(h.nango.saveNangoConnectionRecord).not.toHaveBeenCalled();
  });

  it("readback mismatch throws generic error and does NOT call saveNangoConnectionRecord — and no plaintext / token in error", async () => {
    h.nango.getNangoCredentials.mockResolvedValueOnce({ apiKey: "DIFFERENT_VALUE" } as never);

    try {
      await h.client.saveDrupalInstance({
        name: "Site A",
        siteUrl: "https://a.example.com",
        mcpApiKey: KEY,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/Nango credential verification failed/);
      expect(msg).not.toContain(KEY);
      expect(msg).not.toContain("DIFFERENT_VALUE");
    }

    expect(h.nango.saveNangoConnectionRecord).not.toHaveBeenCalled();
  });

  it("readback returns null → treated as mismatch, no persist", async () => {
    h.nango.getNangoCredentials.mockResolvedValueOnce(null);

    await expect(
      h.client.saveDrupalInstance({ name: "Site A", siteUrl: "https://a.example.com", mcpApiKey: KEY }),
    ).rejects.toThrow(/Nango credential verification failed/);

    expect(h.nango.saveNangoConnectionRecord).not.toHaveBeenCalled();
  });

  it("edit-without-key preserves existing Nango credential — skips Nango entirely, rewrites name/URL only", async () => {
    // Pre-seed an instance.
    const existingId = "existing-uuid";
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: existingId,
          name: "Old name",
          siteUrl: "https://old.example.com",
          nangoConnectionId: existingId,
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };

    const result = await h.client.saveDrupalInstance({
      id: existingId,
      name: "New name",
      siteUrl: "https://new.example.com",
      // mcpApiKey omitted — edit-without-key
    });

    expect(result.id).toBe(existingId);
    expect(result.name).toBe("New name");
    expect(result.siteUrl).toBe("https://new.example.com");
    expect(result.nangoConnectionId).toBe(existingId);

    // No Nango calls — edit-without-key path
    expect(h.nango.ensureNangoConnectorIntegration).not.toHaveBeenCalled();
    expect(h.nango.importNangoConnection).not.toHaveBeenCalled();
    expect(h.nango.getNangoCredentials).not.toHaveBeenCalled();
    expect(h.nango.saveNangoConnectionRecord).not.toHaveBeenCalled();
  });

  it("edit-with-rotation goes through the full save dance", async () => {
    const existingId = "existing-uuid";
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: existingId,
          name: "Old name",
          siteUrl: "https://old.example.com",
          nangoConnectionId: existingId,
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    h.nango.getNangoCredentials.mockResolvedValueOnce({ apiKey: "NEW_TOKEN_xyz" } as never);

    const result = await h.client.saveDrupalInstance({
      id: existingId,
      name: "Old name",
      siteUrl: "https://old.example.com",
      mcpApiKey: "NEW_TOKEN_xyz",
    });

    expect(result.id).toBe(existingId);
    expect(h.nango.importNangoConnection).toHaveBeenCalledTimes(1);
    expect(h.nango.saveNangoConnectionRecord).toHaveBeenCalledTimes(1);
  });

  it("rejects new instance without a key (key required when adding)", async () => {
    await expect(
      h.client.saveDrupalInstance({ name: "Site A", siteUrl: "https://a.example.com" }),
    ).rejects.toThrow(/MCP API key is required/);
    // Nango not called at all.
    expect(h.nango.importNangoConnection).not.toHaveBeenCalled();
  });

  it("cinatra#967: gates the post-import readback via enforceInstanceConnectionUse, threading the {orgId, runBy} binding, BEFORE the raw readback call", async () => {
    const callOrder: string[] = [];
    h.gate.enforceInstanceConnectionUse.mockImplementationOnce(async () => {
      callOrder.push("gate");
      return { gated: false };
    });
    h.nango.getNangoCredentials.mockImplementationOnce(async () => {
      callOrder.push("readback");
      return { apiKey: KEY } as never;
    });

    const result = await h.client.saveDrupalInstance({
      name: "Site A",
      siteUrl: "https://a.example.com",
      mcpApiKey: KEY,
      orgId: "org-1",
      runBy: "user-1",
    });

    expect(h.gate.enforceInstanceConnectionUse).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorKey: "drupal",
        connectionId: result.id,
        binding: { orgId: "org-1", runBy: "user-1" },
        // The audit-source label the core client emitted — kept EXACTLY.
        source: "drupal-api",
      }),
    );
    expect(callOrder).toEqual(["gate", "readback"]);
    // Explicit binding provided → the session source is never consulted.
    expect(h.gate.resolveTrustedSessionBinding).not.toHaveBeenCalled();
  });

  it("cinatra#967: a denied gate propagates (fails closed) and never persists or saves the Nango pointer", async () => {
    class Denied extends Error {}
    h.gate.enforceInstanceConnectionUse.mockRejectedValueOnce(new Denied("denied"));

    await expect(
      h.client.saveDrupalInstance({ name: "Site A", siteUrl: "https://a.example.com", mcpApiKey: KEY }),
    ).rejects.toThrow(Denied);

    expect(h.nango.getNangoCredentials).not.toHaveBeenCalled();
    expect(h.nango.saveNangoConnectionRecord).not.toHaveBeenCalled();
  });

  it("rejects a short rotation key (min 8 chars)", async () => {
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: "x",
          name: "x",
          siteUrl: "https://x.example.com",
          nangoConnectionId: "x",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    await expect(
      h.client.saveDrupalInstance({ id: "x", name: "x", siteUrl: "https://x.example.com", mcpApiKey: "short" }),
    ).rejects.toThrow(/at least 8 chars/);
  });

  it("captures the {orgId, runBy} binding from the host trusted-session source when the caller passes none (null folds to no-binding)", async () => {
    h.gate.resolveTrustedSessionBinding.mockResolvedValueOnce({ orgId: "org-7", runBy: "user-7" });
    h.nango.getNangoCredentials.mockResolvedValueOnce({ apiKey: KEY } as never);

    const result = await h.client.saveDrupalInstance({
      name: "Site A",
      siteUrl: "https://a.example.com",
      mcpApiKey: KEY,
    });

    expect(h.gate.resolveTrustedSessionBinding).toHaveBeenCalledTimes(1);
    expect(h.gate.enforceInstanceConnectionUse).toHaveBeenCalledWith(
      expect.objectContaining({ binding: { orgId: "org-7", runBy: "user-7" } }),
    );
    expect(result.orgId).toBe("org-7");
    expect(result.runBy).toBe("user-7");
  });

  it("edit-without-session PRESERVES the row's existing binding (a null session never overwrites with undefined)", async () => {
    const existingId = "existing-uuid";
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: existingId,
          name: "Old name",
          siteUrl: "https://old.example.com",
          nangoConnectionId: existingId,
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          orgId: "org-existing",
          runBy: "user-existing",
        },
      ],
    };

    const result = await h.client.saveDrupalInstance({
      id: existingId,
      name: "New name",
      siteUrl: "https://old.example.com",
    });

    expect(h.gate.resolveTrustedSessionBinding).toHaveBeenCalledTimes(1);
    expect(result.orgId).toBe("org-existing");
    expect(result.runBy).toBe("user-existing");
  });
});

describe("deleteDrupalInstance cleanup symmetry", () => {
  it("removes the row + Nango pointer + best-effort Nango connection delete", async () => {
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: "site-1",
          name: "Site 1",
          siteUrl: "https://s.example.com",
          nangoConnectionId: "site-1",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };

    await h.client.deleteDrupalInstance("site-1");

    expect((CONFIG_STORE.drupal as { instances: unknown[] }).instances).toEqual([]);
    expect(h.nango.removeNangoConnectionRecord).toHaveBeenCalledWith("drupal", "site-1");
    expect(h.nango.deleteNangoConnection).toHaveBeenCalledWith("cinatra-drupal", "site-1");
  });

  it("survives a Nango deleteConnection error (swallows + warns through the injected #981 warn sink, keeping the [drupal-api] label)", async () => {
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: "site-1",
          name: "Site 1",
          siteUrl: "https://s.example.com",
          nangoConnectionId: "site-1",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    h.nango.deleteNangoConnection.mockRejectedValueOnce(new Error("nango down"));

    await expect(h.client.deleteDrupalInstance("site-1")).resolves.toBeUndefined();

    expect((CONFIG_STORE.drupal as { instances: unknown[] }).instances).toEqual([]);
    expect(h.warn).toHaveBeenCalledWith(
      "[drupal-api] deleteNangoConnection failed for site-1 (ignored): nango down",
    );
  });

  it("skips Nango delete when isNangoConfigured() === false (still drops local row + pointer)", async () => {
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: "site-1",
          name: "Site 1",
          siteUrl: "https://s.example.com",
          nangoConnectionId: "site-1",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    h.nango.isNangoConfigured.mockReturnValue(false);

    await h.client.deleteDrupalInstance("site-1");

    expect(h.nango.deleteNangoConnection).not.toHaveBeenCalled();
    expect(h.nango.removeNangoConnectionRecord).toHaveBeenCalled();
    expect((CONFIG_STORE.drupal as { instances: unknown[] }).instances).toEqual([]);
  });
});

describe("getDrupalAPISettings filter", () => {
  it("filters out rows that lack nangoConnectionId", () => {
    CONFIG_STORE.drupal = {
      instances: [
        // Row with Nango pointer — included
        {
          id: "migrated",
          name: "ok",
          siteUrl: "https://ok.example.com",
          nangoConnectionId: "migrated",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        // Row without Nango pointer — filtered out
        {
          id: "legacy",
          name: "legacy",
          siteUrl: "https://legacy.example.com",
          mcpApiKey: "STILL_PLAINTEXT",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const result = h.client.getDrupalAPISettings();
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0].id).toBe("migrated");
  });
});

describe("persistLocalDevDrupalInstanceUnvalidated — localhost no-Nango first wire", () => {
  it("lands a COMPLETE row (nangoConnectionId=id, lastValidatedAt UNSET) WITHOUT any Nango side effect", async () => {
    h.nango.isNangoConfigured.mockReturnValue(false);

    const row = await h.client.persistLocalDevDrupalInstanceUnvalidated({
      name: "Local Drupal (dev auto)",
      siteUrl: "http://localhost:8082/",
    });

    // Complete row: id, name, siteUrl (trailing slash trimmed), nangoConnectionId=id.
    expect(row.id).toBeTruthy();
    expect(row.nangoConnectionId).toBe(row.id);
    expect(row.siteUrl).toBe("http://localhost:8082");
    expect(row.providerConfigKey).toBe("cinatra-drupal");
    // NOT validated — no false attribution.
    expect(row.lastValidatedAt).toBeUndefined();
    // Listed by getDrupalAPISettings (its filter requires a non-empty nangoConnectionId).
    expect(h.client.getDrupalAPISettings().instances.some((i) => i.id === row.id)).toBe(true);
    // NO Nango pointer / import was written (a pointer with no readback-verified
    // Bearer would dangle).
    expect(h.nango.importNangoConnection).not.toHaveBeenCalled();
    expect(h.nango.saveNangoConnectionRecord).not.toHaveBeenCalled();
    expect(h.nango.ensureNangoConnectorIntegration).not.toHaveBeenCalled();
  });

  it("is idempotent — reuses the existing row id (by siteUrl) and does not duplicate", async () => {
    h.nango.isNangoConfigured.mockReturnValue(false);
    const first = await h.client.persistLocalDevDrupalInstanceUnvalidated({
      name: "Local Drupal (dev auto)",
      siteUrl: "http://localhost:8082",
    });
    const second = await h.client.persistLocalDevDrupalInstanceUnvalidated({
      name: "Local Drupal (dev auto)",
      siteUrl: "http://localhost:8082",
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt); // createdAt preserved
    expect(
      h.client.getDrupalAPISettings().instances.filter((i) => i.siteUrl === "http://localhost:8082"),
    ).toHaveLength(1);
  });

  it("accepts 127.0.0.1 and the [::1] IPv6 loopback form", async () => {
    h.nango.isNangoConfigured.mockReturnValue(false);
    await expect(
      h.client.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://127.0.0.1:8082" }),
    ).resolves.toMatchObject({ siteUrl: "http://127.0.0.1:8082" });
    await expect(
      h.client.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://[::1]:8082" }),
    ).resolves.toBeTruthy();
  });

  it("REFUSES a non-local site URL (hard localhost gate; never a production affordance)", async () => {
    await expect(
      h.client.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "https://drupal.example.com" }),
    ).rejects.toThrow(/local-dev only/);
    // Nothing persisted.
    expect(h.client.getDrupalAPISettings().instances).toHaveLength(0);
  });

  it("REFUSES a missing instance name", async () => {
    await expect(
      h.client.persistLocalDevDrupalInstanceUnvalidated({ name: "  ", siteUrl: "http://localhost:8082" }),
    ).rejects.toThrow(/name is required/i);
  });
});

describe("listDrupalInstances / getDrupalAPIStatus", () => {
  it("orders most-recently-updated first and reports the status projection", async () => {
    CONFIG_STORE.drupal = {
      instances: [
        {
          id: "old",
          name: "Old",
          siteUrl: "https://old.example.com",
          nangoConnectionId: "old",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          lastValidatedAt: "2026-01-02T00:00:00Z",
        },
        {
          id: "new",
          name: "New",
          siteUrl: "https://new.example.com",
          nangoConnectionId: "new",
          providerConfigKey: "cinatra-drupal",
          createdAt: "2026-03-01T00:00:00Z",
          updatedAt: "2026-03-01T00:00:00Z",
        },
      ],
    };
    await expect(h.client.listDrupalInstances()).resolves.toMatchObject([
      { id: "new" },
      { id: "old" },
    ]);
    await expect(h.client.getDrupalAPIStatus()).resolves.toEqual({
      instanceCount: 2,
      instances: [
        { id: "new", name: "New", siteUrl: "https://new.example.com", lastValidatedAt: undefined },
        { id: "old", name: "Old", siteUrl: "https://old.example.com", lastValidatedAt: "2026-01-02T00:00:00Z" },
      ],
    });
  });
});
