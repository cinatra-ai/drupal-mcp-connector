// `register(ctx)` shape — the Stage 3 transport-DI inversion: the connector
// binds its host deps slot itself (always-bind since the post-cutover sweep, lazy per-call
// host-service resolution, nango members over the connector-authored
// `nango-system` surface). Leaf-graph pin: the entry imports ONLY ./deps.

import { describe, expect, it, vi, beforeEach } from "vitest";

import { register } from "../register";
import {
  getDrupalDeps,
  listMcpInstancesSorted,
  registerDrupalConnector,
  _resetDrupalDepsForTests,
} from "../deps";

function activateWithServices(impls: Record<string, unknown>) {
  const resolveProviders = vi.fn((capability: string) =>
    impls[capability] !== undefined
      ? [{ packageName: "@cinatra-ai/host", impl: impls[capability] }]
      : [],
  );
  const registerProvider = vi.fn();
  const ctx = {
    capabilities: { registerProvider, resolveProviders },
  } as never;
  register(ctx);
  return { resolveProviders, registerProvider };
}

/** The impl register(ctx) registered under `capability` (cinatra#975 W2/W3). */
function registeredImpl<T>(registerProvider: ReturnType<typeof vi.fn>, capability: string): T {
  const call = registerProvider.mock.calls.find(([id]) => id === capability);
  if (!call) throw new Error(`no provider registered for ${capability}`);
  return call[1].impl as T;
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
    // No host-service resolution happened at registration (probe-safe).
    expect(resolveProviders).not.toHaveBeenCalled();
    expect(getDrupalDeps().decodeCursor("x")).toBe(7);
    expect(getDrupalDeps().listMcpInstances()).toEqual([]);
    expect(decodeCursor).toHaveBeenCalledTimes(1);
    expect(listInstances).toHaveBeenCalledTimes(1);
  });

  it("wires the actor-scoped lister against a post-cutover host AND fails closed against a pre-cutover host", async () => {
    // Post-cutover host: drupal-mcp service publishes `listAuthorizedInstances`.
    const authorized = [
      {
        id: "a",
        name: "Site a",
        siteUrl: "https://a.example",
        nangoConnectionId: "a",
        providerConfigKey: "cinatra-drupal",
      },
    ];
    const listAuthorizedInstances = vi.fn(async () => authorized);
    const listInstances = vi.fn(() => [
      ...authorized,
      {
        id: "foreign",
        name: "Foreign",
        siteUrl: "https://foreign.example",
        nangoConnectionId: "foreign",
        providerConfigKey: "cinatra-drupal",
      },
    ]);
    activateWithServices({
      "@cinatra-ai/host:drupal-mcp": {
        listInstances,
        listAuthorizedInstances,
        probe: vi.fn(),
        resolveServerUrl: vi.fn(),
        isPrivateUrl: vi.fn(),
      },
    });
    const lister = getDrupalDeps().listAuthorizedMcpInstances!;
    await expect(lister()).resolves.toEqual(authorized);
    expect(listAuthorizedInstances).toHaveBeenCalledTimes(1);
    // The actor-scoped lister NEVER consults the global unscoped listInstances.
    expect(listInstances).not.toHaveBeenCalled();

    // Pre-cutover host: `listAuthorizedInstances` ABSENT → the dep fails closed
    // (returns []) at call time, NEVER falling back to the global listInstances.
    _resetDrupalDepsForTests();
    const legacyListInstances = vi.fn(() => authorized);
    activateWithServices({
      "@cinatra-ai/host:drupal-mcp": {
        listInstances: legacyListInstances,
        probe: vi.fn(),
        resolveServerUrl: vi.fn(),
        isPrivateUrl: vi.fn(),
      },
    });
    await expect(getDrupalDeps().listAuthorizedMcpInstances!()).resolves.toEqual([]);
    expect(legacyListInstances).not.toHaveBeenCalled();
  });

  it("binds the instance-admin members LAZILY against the extended drupal-mcp service (cinatra#172 Stage H2)", async () => {
    const getAPIStatus = vi.fn(async () => ({ instanceCount: 0, instances: [] }));
    const saveInstance = vi.fn(async (input: unknown) => ({ id: "i-1", echoed: input }));
    const deleteInstance = vi.fn(async () => {});
    const getInstanceStatuses = vi.fn(async () => [
      { id: "i-1", name: "S", siteUrl: "https://d.example", status: "registered" as const, isPrivate: false },
    ]);
    const { resolveProviders } = activateWithServices({
      "@cinatra-ai/host:drupal-mcp": {
        listInstances: vi.fn(() => []),
        probe: vi.fn(),
        resolveServerUrl: vi.fn(),
        isPrivateUrl: vi.fn(),
        getAPIStatus,
        saveInstance,
        deleteInstance,
        getInstanceStatuses,
      },
    });
    // Slot bound at activation, BEFORE any settings-page action / MCP handler
    // resolves it — and with NO host-service resolution yet (probe-safe).
    expect(resolveProviders).not.toHaveBeenCalled();

    await expect(getDrupalDeps().getApiStatus()).resolves.toEqual({ instanceCount: 0, instances: [] });
    const saveInput = { name: "S", siteUrl: "https://d.example", mcpApiKey: "k".repeat(12) };
    await expect(getDrupalDeps().saveInstance(saveInput)).resolves.toMatchObject({ id: "i-1" });
    expect(saveInstance).toHaveBeenCalledWith(saveInput);
    await expect(getDrupalDeps().deleteInstance("i-1")).resolves.toBeUndefined();
    expect(deleteInstance).toHaveBeenCalledWith("i-1");
    await expect(getDrupalDeps().listInstanceStatuses()).resolves.toEqual([
      { id: "i-1", name: "S", siteUrl: "https://d.example", status: "registered", isPrivate: false },
    ]);
    expect(getAPIStatus).toHaveBeenCalledTimes(1);
    expect(getInstanceStatuses).toHaveBeenCalledTimes(1);
  });

  it("listMcpInstancesSorted orders most-recently-updated first (host listDrupalInstances ordering)", () => {
    activateWithServices({
      "@cinatra-ai/host:drupal-mcp": {
        listInstances: () => [
          { id: "old", updatedAt: "2026-01-01T00:00:00Z" },
          { id: "new", updatedAt: "2026-03-01T00:00:00Z" },
          { id: "mid", updatedAt: "2026-02-01T00:00:00Z" },
        ],
        probe: vi.fn(),
        resolveServerUrl: vi.fn(),
        isPrivateUrl: vi.fn(),
      },
    });
    expect(listMcpInstancesSorted().map((i) => i.id)).toEqual(["new", "mid", "old"]);
  });

  it("REPLACES a pre-bound deps slot (always-bind — a hot-update digest swap re-binds fresh resolvers)", () => {
    const sentinel = vi.fn(() => 42);
    registerDrupalConnector({ decodeCursor: sentinel } as never);
    activateWithServices({ "@cinatra-ai/host:mcp-pagination": { decodeCursor: () => 0 } });
    expect(getDrupalDeps().decodeCursor("x")).toBe(0);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("requireInstanceWriteAuthority binds the host instance-write-authority service for KIND 'drupal' and forwards only instanceId+primitiveName (cinatra#409)", async () => {
    const requireWrite = vi.fn(async () => {});
    const selectForConnector = vi.fn((_kind: string) => ({ requireWrite }));
    activateWithServices({
      // The REAL host capability id + shape (HostInstanceWriteAuthorityService):
      // selectForConnector(kind).requireWrite({ instanceId, primitiveName }).
      "@cinatra-ai/host:instance-write-authority": { selectForConnector },
    });
    await expect(
      getDrupalDeps().requireInstanceWriteAuthority({
        instanceId: "site-1",
        primitiveName: "drupal_node_update",
      }),
    ).resolves.toBeUndefined();
    // The connector names ONLY its own static kind — never a package id.
    expect(selectForConnector).toHaveBeenCalledWith("drupal");
    // It forwards ONLY the non-identity coordinates; the host derives the
    // trusted actor itself (never from the connector).
    expect(requireWrite).toHaveBeenCalledWith({
      instanceId: "site-1",
      primitiveName: "drupal_node_update",
    });
  });

  it("requireInstanceWriteAuthority FAILS LOUD on an old host that did not publish the instance-write-authority service (cinatra#409 fail-closed)", async () => {
    // No @cinatra-ai/host:instance-write-authority provider registered.
    activateWithServices({});
    await expect(
      getDrupalDeps().requireInstanceWriteAuthority({
        instanceId: "site-1",
        primitiveName: "drupal_node_update",
      }),
    ).rejects.toThrow(/host service "@cinatra-ai\/host:instance-write-authority" is not registered/);
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
    // The instance-admin members ride the same drupal-mcp service (H2).
    expect(() => getDrupalDeps().getApiStatus()).toThrow(
      /host service "@cinatra-ai\/host:drupal-mcp" is not registered/,
    );
  });

  it("registers the connector-owned drupal-mcp instance-admin provider under the SAME capability id, keyed by the connector package (cinatra#975 W3)", () => {
    const { registerProvider, resolveProviders } = activateWithServices({});
    const call = registerProvider.mock.calls.find(([id]) => id === "@cinatra-ai/host:drupal-mcp");
    expect(call).toBeTruthy();
    // Coexistence contract: keyed by the CONNECTOR package name (the host's own
    // provider stays registered under @cinatra-ai/host until the core-eviction
    // follow-up re-points it at this one).
    expect(call![1].packageName).toBe("@cinatra-ai/drupal-mcp-connector");
    // The relocated drupal-api member set — and ONLY it. The connection-probe
    // members and the actor-gated lister are explicit NON-members (they stay
    // host-side: drupal-mcp-connection / the instance-list authority — authz
    // stays core).
    const impl = call![1].impl as Record<string, unknown>;
    for (const member of [
      "listInstances",
      "getAPIStatus",
      "saveInstance",
      "deleteInstance",
      "devPersistLocalInstanceUnvalidated",
    ]) {
      expect(typeof impl[member]).toBe("function");
    }
    for (const nonMember of [
      "probe",
      "resolveServerUrl",
      "isPrivateUrl",
      "getInstanceStatuses",
      "listAuthorizedInstances",
      "devProbeWithBearer",
      "devInvalidateProbeCache",
    ]) {
      expect(impl[nonMember]).toBeUndefined();
    }
    // Probe-safe: building + registering the impl resolved NO host service.
    expect(resolveProviders).not.toHaveBeenCalled();
  });

  it("W3 provider members resolve connector-config / nango-system LAZILY at call time (byte-equivalent persistence under connector_config:drupal)", () => {
    const store: Record<string, unknown> = {
      drupal: {
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
      },
    };
    const { registerProvider, resolveProviders } = activateWithServices({
      "@cinatra-ai/host:connector-config": {
        read: <T,>(key: string, fallback: T): T => (store[key] as T) ?? fallback,
        write: (key: string, value: unknown) => {
          store[key] = value;
        },
      },
    });
    const impl = registeredImpl<{ listInstances(): Array<{ id: string }> }>(
      registerProvider,
      "@cinatra-ai/host:drupal-mcp",
    );
    expect(resolveProviders).not.toHaveBeenCalled();
    expect(impl.listInstances().map((i) => i.id)).toEqual(["site-1"]);
    expect(resolveProviders).toHaveBeenCalledWith("@cinatra-ai/host:connector-config");
  });

  it("W3 devPersistLocalInstanceUnvalidated is REFUSED outside development (runtime-mode gate) and persists + returns {id} in dev", async () => {
    const store: Record<string, unknown> = {};
    const impls = {
      "@cinatra-ai/host:connector-config": {
        read: <T,>(key: string, fallback: T): T => (store[key] as T) ?? fallback,
        write: (key: string, value: unknown) => {
          store[key] = value;
        },
      },
      "@cinatra-ai/host:runtime-mode": { isDevelopment: () => false },
      "nango-system": {
        isNangoConfigured: () => false,
        providerConfigKeys: { drupal: "cinatra-drupal" },
      },
    };
    const { registerProvider } = activateWithServices(impls);
    const impl = registeredImpl<{
      devPersistLocalInstanceUnvalidated(input: {
        name: string;
        siteUrl: string;
      }): Promise<{ id: string }>;
    }>(registerProvider, "@cinatra-ai/host:drupal-mcp");

    await expect(
      impl.devPersistLocalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082" }),
    ).rejects.toThrow(/dev-only devSetup provisioning member; refused outside development/);
    expect(store.drupal).toBeUndefined();

    impls["@cinatra-ai/host:runtime-mode"] = { isDevelopment: () => true };
    await expect(
      impl.devPersistLocalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082" }),
    ).resolves.toMatchObject({ id: expect.any(String) });
    expect((store.drupal as { instances: unknown[] }).instances).toHaveLength(1);
  });

  it("fails LOUD with the package name + registration step when the SLOT itself is unbound", () => {
    // No register(ctx) ran at all (e.g. a settings-page bundle resolving the
    // slot before activation): the getter must name the package and the
    // missing registration step.
    expect(() => getDrupalDeps()).toThrow(
      /@cinatra-ai\/drupal-mcp-connector: host runtime deps not registered[\s\S]*registerDrupalConnector/,
    );
  });
});
