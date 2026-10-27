// drupal-mcp-connector#101 (cinatra#3924, cinatra#4387): after the dev setup,
// the saved Drupal instance carries the dev owner's {orgId, runBy}, so the
// host's write-authority gate (instance_unbound otherwise) admits the dev
// administrator.
//
// The hook runs END TO END over the REAL connector instance client
// (buildDrupalInstanceClient) on an in-memory connector-config store and a
// fake Nango vault. The HOST side is a stand-in modelled on core's drupal-mcp
// dev members after cinatra#4387 (whose own tests, in cinatra's
// host-connector-services-publication.test.ts, pin the real members):
// `devSaveInstance` and the dev persist wrapper drop any caller org/user and add
// the boot's dev owner; `saveInstance` binds nothing. The hook itself never
// passes an org or user id (pinned below).
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

function harness(opts: {
  nango: boolean;
  owner?: typeof OWNER | null;
  hostHasDevSave?: boolean;
  probe?: string;
  /** The host's key-less devSaveInstance (the re-bind) throws before it saves. */
  rebindThrows?: boolean;
  /** The host's key-less devSaveInstance saves the row and THEN rejects. */
  rebindRejectsAfterSave?: boolean;
  /** The host's KEYED devSaveInstance (first wire, rotation, transition) throws. */
  keyedThrows?: boolean;
}) {
  let owner = opts.owner === undefined ? OWNER : opts.owner;
  let keyedThrows = opts.keyedThrows === true;
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
      if (opts.rebindThrows && input.mcpApiKey === undefined) throw new Error("host re-bind failed");
      if (keyedThrows && input.mcpApiKey !== undefined) throw new Error("host keyed save failed");
      const saved = await client.saveDrupalInstance(bind(input) as never);
      if (opts.rebindRejectsAfterSave && input.mcpApiKey === undefined) throw new Error("host failed after the save");
      return saved;
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
    setKeyedThrows: (on: boolean) => {
      keyedThrows = on;
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

  it("re-bind with Nango on a key that did not reconcile (probe unreachable): the row is still bound, the key kept", async () => {
    // The binding does not depend on the key's health: a key-less save imports,
    // reads back and writes no credential, so the row is bound even while the
    // stored key is unconfirmed.
    const h = harness({ nango: true, probe: "unreachable" });
    const seeded = await h.client.saveDrupalInstance({
      name: LOCAL_DRUPAL.instanceName,
      siteUrl: LOCAL_DRUPAL.siteUrl,
      mcpApiKey: STORED,
    });
    expect(h.row()!.orgId).toBeUndefined();
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status).toMatchObject({ status: "already-wired" });
    expect((status as { detail?: string }).detail).toContain("remote-key unconfirmed");
    const rebinds = h.hookCalls.filter((c) => c.member === "devSaveInstance");
    expect(rebinds).toHaveLength(1);
    expect(rebinds[0].input.mcpApiKey).toBeUndefined();
    expect(h.vault.get(seeded.id)).toBe(STORED);
    expect(h.row()).toMatchObject({ id: seeded.id, orgId: OWNER.orgId, runBy: OWNER.runBy });
  });

  it("a failed re-bind is caught: one fixed log line, the boot status and detail unchanged (a host that throws before saving leaves the row unbound)", async () => {
    const seed = async (h: ReturnType<typeof harness>) =>
      h.client.saveDrupalInstance({ name: LOCAL_DRUPAL.instanceName, siteUrl: LOCAL_DRUPAL.siteUrl, mcpApiKey: STORED });
    const ok = harness({ nango: true, probe: "registered", hostHasDevSave: false });
    await seed(ok);
    const expected = await autoSetupLocalDrupal(ok.deps);
    const h = harness({ nango: true, probe: "registered", rebindThrows: true });
    const seeded = await seed(h);
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status).toEqual({ ...expected, detail: (expected as { detail: string }).detail.replace(/instance \S+/, `instance ${seeded.id}`) });
    expect(status).toMatchObject({ status: "already-wired" });
    const logs = (h.deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0]);
    expect(logs.filter((l) => l === "instance re-bind to the dev owner failed (the row may or may not be bound; the next boot retries).")).toHaveLength(1);
    expect(h.row()!.orgId).toBeUndefined();
    expect(h.vault.get(seeded.id)).toBe(STORED);
  });

  it("a re-bind the host saved and then rejected: the same fixed log line, which claims nothing about the row, and the boot status unchanged", async () => {
    const seed = async (h: ReturnType<typeof harness>) =>
      h.client.saveDrupalInstance({ name: LOCAL_DRUPAL.instanceName, siteUrl: LOCAL_DRUPAL.siteUrl, mcpApiKey: STORED });
    const ok = harness({ nango: true, probe: "registered", hostHasDevSave: false });
    await seed(ok);
    const expected = await autoSetupLocalDrupal(ok.deps);
    const h = harness({ nango: true, probe: "registered", rebindRejectsAfterSave: true });
    const seeded = await seed(h);
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status).toEqual({ ...expected, detail: (expected as { detail: string }).detail.replace(/instance \S+/, `instance ${seeded.id}`) });
    const logs = (h.deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0]);
    expect(logs.filter((l) => l === "instance re-bind to the dev owner failed (the row may or may not be bound; the next boot retries).")).toHaveLength(1);
    expect(logs.some((l) => typeof l === "string" && l.includes("kept the row"))).toBe(false);
    // The save landed before the rejection: the row IS bound, the key kept.
    expect(h.row()).toMatchObject({ id: seeded.id, orgId: OWNER.orgId, runBy: OWNER.runBy });
    expect(h.vault.get(seeded.id)).toBe(STORED);
  });

  it("a keyed devSaveInstance that rejects on the first wire fails the boot with the fixed reason and never falls back to saveInstance", async () => {
    const h = harness({ nango: true, keyedThrows: true });
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status).toEqual({ status: "error", reason: "saveDrupalInstance failed (first wire)" });
    expect(h.hookCalls.map((c) => c.member)).toEqual(["devSaveInstance"]);
    expect(h.row()).toBeUndefined();
  });

  it("a keyed devSaveInstance that rejects on a rotation keeps the stored key, never falls back to saveInstance, and the key-less re-bind still binds the row", async () => {
    const h = harness({ nango: true, probe: "auth_error", keyedThrows: true });
    const seeded = await h.client.saveDrupalInstance({ name: LOCAL_DRUPAL.instanceName, siteUrl: LOCAL_DRUPAL.siteUrl, mcpApiKey: STORED });
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status.status).toBe("already-wired");
    expect(h.hookCalls.map((c) => [c.member, c.input.mcpApiKey])).toEqual([
      ["devSaveInstance", MINTED],
      ["devSaveInstance", undefined],
    ]);
    expect(h.vault.get(seeded.id)).toBe(STORED);
    expect(h.row()).toMatchObject({ id: seeded.id, orgId: OWNER.orgId, runBy: OWNER.runBy });
  });

  it("a keyed devSaveInstance that rejects on the local-dev transition imports no key, never falls back to saveInstance, and the key-less re-bind still binds the row", async () => {
    const h = harness({ nango: false, owner: null });
    await autoSetupLocalDrupal(h.deps);
    h.setNango(true);
    h.setOwner(OWNER);
    h.setKeyedThrows(true);
    h.hookCalls.length = 0;
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status.status).toBe("already-wired");
    expect(h.hookCalls.map((c) => [c.member, c.input.mcpApiKey])).toEqual([
      ["devSaveInstance", MINTED],
      ["devSaveInstance", undefined],
    ]);
    expect(h.vault.has(h.row()!.id)).toBe(false);
    expect(h.row()).toMatchObject({ orgId: OWNER.orgId, runBy: OWNER.runBy });
  });

  it("a row already bound to owner A is bound to this boot's owner B, with Nango and without", async () => {
    const A = { orgId: "org-A", runBy: "user-A" };
    const B = { orgId: "org-B", runBy: "user-B" };
    const withNango = harness({ nango: true, probe: "registered", owner: B });
    const seeded = await withNango.client.saveDrupalInstance({
      name: LOCAL_DRUPAL.instanceName,
      siteUrl: LOCAL_DRUPAL.siteUrl,
      mcpApiKey: STORED,
      ...A,
    } as never);
    expect(withNango.row()).toMatchObject(A);
    await autoSetupLocalDrupal(withNango.deps);
    expect(withNango.row()).toMatchObject({ id: seeded.id, ...B });
    expect(withNango.vault.get(seeded.id)).toBe(STORED);
    const noNango = harness({ nango: false, owner: B });
    await noNango.client.persistLocalDevDrupalInstanceUnvalidated({ name: LOCAL_DRUPAL.instanceName, siteUrl: LOCAL_DRUPAL.siteUrl, ...A });
    expect(noNango.row()).toMatchObject(A);
    await autoSetupLocalDrupal(noNango.deps);
    expect(noNango.row()).toMatchObject(B);
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
    const otherHalf = await c.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082", orgId: " ", runBy: "u-9" });
    expect(otherHalf).toMatchObject({ orgId: "o-1", runBy: "u-1" });
  });

  it("non-string pair values count as absent: an existing binding is kept, a new row gets none", async () => {
    const c = client();
    await c.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082", orgId: "o-1", runBy: "u-1" });
    for (const bad of [
      { orgId: 42, runBy: {} },
      { orgId: "o-2", runBy: 7 },
      { orgId: ["o-2"], runBy: "u-2" },
      { orgId: null, runBy: true },
    ]) {
      const row = await c.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082", ...bad } as never);
      expect(row).toMatchObject({ orgId: "o-1", runBy: "u-1" });
    }
    const fresh = await c.persistLocalDevDrupalInstanceUnvalidated({ name: "m", siteUrl: "http://localhost:8083", orgId: 42, runBy: "u-1" } as never);
    expect(fresh.orgId).toBeUndefined();
    expect(fresh.runBy).toBeUndefined();
  });

  it("a new row with half a pair has no binding", async () => {
    const c = client();
    const row = await c.persistLocalDevDrupalInstanceUnvalidated({ name: "n", siteUrl: "http://localhost:8082", orgId: "o-1" });
    expect(row.orgId).toBeUndefined();
    expect(row.runBy).toBeUndefined();
    const other = await c.persistLocalDevDrupalInstanceUnvalidated({ name: "m", siteUrl: "http://localhost:8083", runBy: "u-1" });
    expect(other.orgId).toBeUndefined();
    expect(other.runBy).toBeUndefined();
  });
});
