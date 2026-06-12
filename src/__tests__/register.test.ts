// `register(ctx)` shape — the Stage 3 transport-DI inversion: the connector
// binds its host deps slot itself (bind-if-absent skew guard, lazy per-call
// host-service resolution, nango members over the connector-authored
// `nango-system` surface). Leaf-graph pin: the entry imports ONLY ./deps.

import { describe, expect, it, vi, beforeEach } from "vitest";

import { register } from "../register";
import { getDrupalDeps, hasDrupalDeps, registerDrupalConnector, _resetDrupalDepsForTests } from "../deps";

function activateWithServices(impls: Record<string, unknown>) {
  const resolveProviders = vi.fn((capability: string) =>
    impls[capability] !== undefined
      ? [{ packageName: "@cinatra-ai/host", impl: impls[capability] }]
      : [],
  );
  const ctx = {
    capabilities: { registerProvider: () => {}, resolveProviders },
  } as never;
  register(ctx);
  return { resolveProviders };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetDrupalDepsForTests();
});

describe("register(ctx) — transport-DI deps binding (Stage 3)", () => {
  it("binds the deps slot when absent, resolving host services LAZILY at call time", () => {
    const decodeCursor = vi.fn(() => 7);
    const listInstances = vi.fn(() => []);
    const { resolveProviders } = activateWithServices({
      "@cinatra-ai/host:mcp-pagination": { decodeCursor, buildListPage: vi.fn() },
      "@cinatra-ai/host:drupal-mcp": {
        listInstances,
        probe: vi.fn(),
        resolveServerUrl: vi.fn(),
        isPrivateUrl: vi.fn(),
      },
    });
    expect(hasDrupalDeps()).toBe(true);
    // No host-service resolution happened at registration (probe-safe).
    expect(resolveProviders).not.toHaveBeenCalled();
    expect(getDrupalDeps().decodeCursor("x")).toBe(7);
    expect(getDrupalDeps().listMcpInstances()).toEqual([]);
    expect(decodeCursor).toHaveBeenCalledTimes(1);
    expect(listInstances).toHaveBeenCalledTimes(1);
  });

  it("does NOT replace a pre-bound deps slot (bind-if-absent skew guard)", () => {
    const sentinel = vi.fn(() => 42);
    registerDrupalConnector({ decodeCursor: sentinel } as never);
    activateWithServices({ "@cinatra-ai/host:mcp-pagination": { decodeCursor: () => 0 } });
    expect(getDrupalDeps().decodeCursor("x")).toBe(42);
    expect(sentinel).toHaveBeenCalledTimes(1);
  });

  it("nango members delegate to the connector-authored nango-system surface", async () => {
    const isNangoConfigured = vi.fn(() => true);
    const buildBearerAuthHeaderFromNango = vi.fn(async () => ({ Authorization: "Bearer t" }));
    activateWithServices({
      "nango-system": { isNangoConfigured, buildBearerAuthHeaderFromNango },
    });
    expect(getDrupalDeps().isNangoConfigured()).toBe(true);
    await expect(
      getDrupalDeps().buildNangoBearerHeader({
        providerConfigKey: "p",
        connectionId: "c",
        label: "drupal",
      }),
    ).resolves.toEqual({ Authorization: "Bearer t" });
  });

  it("fails LOUD (descriptive) on a missing host service at call time", () => {
    activateWithServices({});
    expect(() => getDrupalDeps().listMcpInstances()).toThrow(
      /host service "@cinatra-ai\/host:drupal-mcp" is not registered/,
    );
    expect(() => getDrupalDeps().isNangoConfigured()).toThrow(/nango-system/);
  });
});
