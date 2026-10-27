// drupal-mcp-connector#101 (cinatra#3924, cinatra#4387): after the dev setup,
// the saved Drupal instance carries the dev owner's {orgId, runBy}, so the
// host's write-authority gate (instance_unbound otherwise) admits the dev
// administrator.
//
// The hook runs END TO END over the REAL connector instance client
// (buildDrupalInstanceClient) on an in-memory connector-config store and a
// fake Nango vault. The HOST side is a stand-in for core's drupal-mcp dev
// members after cinatra#4387: `devSaveInstance` and the dev persist wrapper
// drop any caller org/user and add the boot's dev owner, exactly as
// register-host-connector-services.ts does; `saveInstance` binds nothing. The
// hook itself never passes an org or user id (pinned below).
//
// SECRET BOUNDARY: assertions check statuses, ids and equality only.

import { describe, expect, it, vi, beforeEach } from "vitest";

import { autoSetupLocalDrupal, LOCAL_DRUPAL, type DrupalDevSetupDeps } from "../dev-setup";
import {
  buildDrupalInstanceClient,
  type DrupalConnectionGateSlice,
  type DrupalInstanceStoreDeps,
  type DrupalNangoSurfaceSlice,
} from "../lib/drupal-instances";

const OWNER = { orgId: "dev-org-1", runBy: "dev-admin-1" };
const WIDGET_UUID = "widget-uuid-aaaa";
const MINTED = "minted-remote-key-0123456789abcdef";
const STORED = "stored-remote-key-fedcba9876543210";

type Input = Record<string, unknown> & { id?: string; name: string; siteUrl: string; mcpApiKey?: string };

function harness(opts: { nango: boolean; owner?: typeof OWNER | null; hostHasDevSave?: boolean; probe?: string }) {
  let owner = opts.owner === undefined ? OWNER : opts.owner;
  let nangoOn = opts.nango;
  const store: Record<string, unknown> = {};
  const vault = new Map<string, string>();
  const nango = {
    isNangoConfigured: vi.fn(() => nangoOn),
    ensureNangoConnectorIntegration: vi.fn(async () => null),
    importNangoConnection: vi.fn(async (i: { connectionId: string; credentials: { apiKey: string } }) => {
      vault.set(i.connectionId, i.credentials.apiKey);
      return null;
    }),
    getNangoCredentials: vi.fn(async (_k: string, id: string) => (vault.has(id) ? { apiKey: vault.get(id) } : null)),
    deleteNangoConnection: vi.fn(async () => undefined),
    removeNangoConnectionRecord: vi.fn(async () => undefined),
    saveNangoConnectionRecord: vi.fn(async () => undefined),
    providerConfigKeys: { drupal: "cinatra-drupal" },
  };
  const client = buildDrupalInstanceClient({
    connectorConfig: () =>
      ({
        read: <T,>(key: string, fallback: T): T => (store[key] as T) ?? fallback,
        write: (key: string, value: unknown) => {
          store[key] = value;
        },
      }) as unknown as ReturnType<DrupalInstanceStoreDeps["connectorConfig"]>,
    nango: () => nango as unknown as DrupalNangoSurfaceSlice,
    connectionGate: () =>
      ({
        enforceInstanceConnectionUse: async () => ({ gated: false }),
        resolveTrustedSessionBinding: async () => null,
      }) as unknown as DrupalConnectionGateSlice,
    warn: () => {},
  });
  // Stand-in for core's host binding (cinatra#4387 withDevInstallOwnerBinding).
  const bind = (input: Input): Input => {
    const rest: Input = { ...input };
    delete rest.orgId;
    delete rest.runBy;
    return owner ? { ...rest, ...owner } : rest;
  };
  const hookCalls: Array<{ member: string; input: Input }> = [];
  const drupal: Record<string, unknown> = {
    listInstances: () => client.getDrupalAPISettings().instances,
    saveInstance: vi.fn(async (input: Input) => {
      hookCalls.push({ member: "saveInstance", input });
      return client.saveDrupalInstance(input as never);
    }),
    devPersistLocalInstanceUnvalidated: vi.fn(async (input: Input) => {
      hookCalls.push({ member: "devPersistLocalInstanceUnvalidated", input });
      return { id: (await client.persistLocalDevDrupalInstanceUnvalidated(bind(input) as never)).id };
    }),
    devProbeWithBearer: vi.fn(async () => opts.probe ?? "registered"),
    devInvalidateProbeCache: vi.fn(),
  };
  if (opts.hostHasDevSave !== false) {
    drupal.devSaveInstance = vi.fn(async (input: Input) => {
      hookCalls.push({ member: "devSaveInstance", input });
      return client.saveDrupalInstance(bind(input) as never);
    });
  }
  const docker = vi.fn((_c: string, argv: string[]) =>
    argv.includes("mcp-tools:remote-key-create") ? { code: 0, out: `API Key: ${MINTED}\n` } : { code: 0, out: "" },
  );
  const deps = {
    drupal,
    widgetAuth: {
      read: () => ({ apiKey: WIDGET_UUID, generatedAt: "now" }),
      generate: () => ({ apiKey: WIDGET_UUID, generatedAt: "now" }),
    },
    nango,
    helpers: {
      probeDockerContainer: () => true,
      probeHttp: () => true,
      probeHttpReachableWithRetry: async () => true,
      dockerExecCapture: docker,
      isLocalhostUrl: () => true,
      trimTrailingSlashes: (input: string) => {
        let end = input.length;
        while (end > 0 && input.charCodeAt(end - 1) === 47) end--;
        return input.slice(0, end);
      },
    },
    log: vi.fn(),
    mintDevConnectCredential: () => null,
    browserBaseUrl: "http://localhost:3000",
  } as unknown as DrupalDevSetupDeps;
  return {
    deps,
    client,
    vault,
    drupal,
    hookCalls,
    setNango: (on: boolean) => {
      nangoOn = on;
    },
    setOwner: (next: typeof OWNER | null) => {
      owner = next;
    },
    row: () => client.getDrupalAPISettings().instances.find((i) => i.siteUrl === LOCAL_DRUPAL.siteUrl),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dev setup binds the saved Drupal instance to the dev owner (drupal-mcp-connector#101)", () => {
  it("no-Nango path: after the dev setup the saved instance carries the orgId and runBy the host's persist adds", async () => {
    const h = harness({ nango: false });
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status.status).toBe("created");
    expect(h.row()).toMatchObject({ orgId: OWNER.orgId, runBy: OWNER.runBy });
  });

  it("remote-key path: after the first wire the saved instance carries the orgId and runBy the host's devSaveInstance adds", async () => {
    const h = harness({ nango: true });
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status.status).toBe("created");
    expect(h.hookCalls.map((c) => c.member)).toContain("devSaveInstance");
    expect(h.row()).toMatchObject({ orgId: OWNER.orgId, runBy: OWNER.runBy });
    expect(h.vault.get(h.row()!.id)).toBe(MINTED);
  });

  it("re-bind with Nango: an already-wired UNBOUND instance with a working key is bound on the next boot (no key save, no mint)", async () => {
    const h = harness({ nango: true, probe: "registered" });
    // The row as an earlier boot left it: saved with no binding.
    const seeded = await h.client.saveDrupalInstance({
      id: undefined,
      name: LOCAL_DRUPAL.instanceName,
      siteUrl: LOCAL_DRUPAL.siteUrl,
      mcpApiKey: STORED,
    });
    expect(h.row()!.orgId).toBeUndefined();
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status.status).toBe("already-wired");
    expect(h.row()).toMatchObject({ id: seeded.id, orgId: OWNER.orgId, runBy: OWNER.runBy });
    // The re-bind carries no key: the stored credential is untouched.
    expect(h.vault.get(seeded.id)).toBe(STORED);
    const rebinds = h.hookCalls.filter((c) => c.member === "devSaveInstance");
    expect(rebinds).toHaveLength(1);
    expect(rebinds[0].input.mcpApiKey).toBeUndefined();
  });

  it("re-bind without Nango: an already-wired UNBOUND instance is bound on the next boot", async () => {
    const h = harness({ nango: false });
    await h.client.persistLocalDevDrupalInstanceUnvalidated({ name: LOCAL_DRUPAL.instanceName, siteUrl: LOCAL_DRUPAL.siteUrl });
    expect(h.row()!.orgId).toBeUndefined();
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status.status).toBe("already-wired");
    expect(h.row()).toMatchObject({ orgId: OWNER.orgId, runBy: OWNER.runBy });
  });

  it("key rotation (probe 401/403) saves through devSaveInstance and the row ends bound", async () => {
    const h = harness({ nango: true, probe: "auth_error" });
    const seeded = await h.client.saveDrupalInstance({
      name: LOCAL_DRUPAL.instanceName,
      siteUrl: LOCAL_DRUPAL.siteUrl,
      mcpApiKey: STORED,
    });
    await autoSetupLocalDrupal(h.deps);
    const saves = h.hookCalls.filter((c) => c.member === "devSaveInstance" || c.member === "saveInstance");
    expect(saves.map((c) => [c.member, c.input.mcpApiKey])).toEqual([["devSaveInstance", MINTED]]);
    expect(h.vault.get(seeded.id)).toBe(MINTED);
    expect(h.row()).toMatchObject({ orgId: OWNER.orgId, runBy: OWNER.runBy });
  });

  it("local-dev transition (row first wired without Nango, Nango now on) saves through devSaveInstance and the row ends bound", async () => {
    // First boot: no Nango and no owner yet, so the row is left unbound with no credential.
    const h = harness({ nango: false, owner: null });
    await autoSetupLocalDrupal(h.deps);
    expect(h.row()!.orgId).toBeUndefined();
    // Next boot: Nango is configured and the boot has a dev owner.
    h.setNango(true);
    h.setOwner(OWNER);
    h.hookCalls.length = 0;
    await autoSetupLocalDrupal(h.deps);
    const keyed = h.hookCalls.filter((c) => c.input.mcpApiKey !== undefined);
    expect(keyed.map((c) => [c.member, c.input.mcpApiKey])).toEqual([["devSaveInstance", MINTED]]);
    expect(h.vault.get(h.row()!.id)).toBe(MINTED);
    expect(h.row()).toMatchObject({ orgId: OWNER.orgId, runBy: OWNER.runBy });
  });

  it("an older host without devSaveInstance still wires through saveInstance (no binding, as before)", async () => {
    const h = harness({ nango: true, hostHasDevSave: false });
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status.status).toBe("created");
    expect(h.hookCalls.map((c) => c.member)).toEqual(["saveInstance"]);
    expect(h.row()!.orgId).toBeUndefined();
  });

  it("the hook never passes an org or user id itself, on any save or persist", async () => {
    const boots = [
      harness({ nango: false }),
      harness({ nango: true }),
      harness({ nango: true, probe: "auth_error" }),
    ];
    for (const h of boots) {
      await autoSetupLocalDrupal(h.deps);
      await autoSetupLocalDrupal(h.deps);
      expect(h.hookCalls.length).toBeGreaterThan(0);
      for (const c of h.hookCalls) {
        expect(Object.keys(c.input)).not.toContain("orgId");
        expect(Object.keys(c.input)).not.toContain("runBy");
      }
    }
  });
});

describe("persistLocalDevDrupalInstanceUnvalidated binding input (drupal-mcp-connector#101)", () => {
  function client() {
    return harness({ nango: false }).client;
  }

  it("writes a complete {orgId, runBy} pair from its input", async () => {
    const c = client();
    const row = await c.persistLocalDevDrupalInstanceUnvalidated({
      name: "n",
      siteUrl: "http://localhost:8082",
      orgId: " dev-org-1 ",
      runBy: "dev-admin-1",
    });
    expect(row).toMatchObject({ orgId: "dev-org-1", runBy: "dev-admin-1" });
  });

  it("replaces an existing binding with a complete new pair", async () => {
    const c = client();
    await c.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082", orgId: "o-1", runBy: "u-1" });
    const row = await c.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082", orgId: "o-2", runBy: "u-2" });
    expect(row).toMatchObject({ orgId: "o-2", runBy: "u-2" });
  });

  it("keeps the existing binding without a pair, and with half a pair (never half a binding)", async () => {
    const c = client();
    await c.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082", orgId: "o-1", runBy: "u-1" });
    const none = await c.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082" });
    expect(none).toMatchObject({ orgId: "o-1", runBy: "u-1" });
    const half = await c.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082", orgId: "o-9", runBy: " " });
    expect(half).toMatchObject({ orgId: "o-1", runBy: "u-1" });
  });

  it("a new row with half a pair has no binding", async () => {
    const c = client();
    const row = await c.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082", orgId: "o-1" });
    expect(row.orgId).toBeUndefined();
    expect(row.runBy).toBeUndefined();
  });
});
