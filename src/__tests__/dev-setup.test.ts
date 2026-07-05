// Connector-owned dev-setup hook — Drupal remote-key reconcile + no-Nango
// fallback + orchestration routing (relocated from the host's dev-auto-setup
// suite with cinatra#976; the assertions are the same discipline, rebased onto
// the hook's explicit deps):
//   - reuse on a valid probe (no mint, no rotate)
//   - rotate ONLY on a definite 401/403 (auth_error) or the legacy split-brain
//   - NEVER rotate on transient/unreachable (no remote-key churn)
//   - readback-verify before write (a failed mint never overwrites)
//   - the localhost no-Nango fallback persists BEFORE pushing the widget config
//   - the Nango-later transition mints ONCE behind a writeability preflight
//
// SECRET BOUNDARY: assertions only ever check statuses/booleans/equality —
// never log a credential.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// `autoSetupLocalDrupal` checks `existsSync(dev/drupal-module/...)`; in the
// unit sandbox that clone is absent. Force it present so the orchestration
// tests reach the Nango branch under test.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => true),
}));

import {
  parseDrupalRemoteKey,
  ensureDrupalRemoteKeyReconciled,
  wireLocalDrupalWithoutNango,
  autoSetupLocalDrupal,
  type DrupalDevSetupDeps,
} from "../dev-setup";

const WIDGET_UUID = "widget-uuid-aaaa";
const STORED_BEARER = "stored-remote-key-0123456789abcdef";
const FRESH_BEARER = "fresh-remote-key-fedcba9876543210xyz";

type Fakes = {
  deps: DrupalDevSetupDeps;
  docker: ReturnType<typeof vi.fn>;
  getNangoCredentials: ReturnType<typeof vi.fn>;
  isNangoConfigured: ReturnType<typeof vi.fn>;
  ensureNangoConnectorIntegration: ReturnType<typeof vi.fn>;
  saveInstance: ReturnType<typeof vi.fn>;
  listInstances: ReturnType<typeof vi.fn>;
  devPersistLocalInstanceUnvalidated: ReturnType<typeof vi.fn>;
  devProbeWithBearer: ReturnType<typeof vi.fn>;
  devInvalidateProbeCache: ReturnType<typeof vi.fn>;
};

function makeDeps(): Fakes {
  const docker = vi.fn(() => ({ code: 0, out: "" }));
  const getNangoCredentials = vi.fn();
  const isNangoConfigured = vi.fn(() => true);
  const ensureNangoConnectorIntegration = vi.fn(async () => null);
  const saveInstance = vi.fn(async () => ({ id: "drupal-1" }));
  const listInstances = vi.fn(() => []);
  const devPersistLocalInstanceUnvalidated = vi.fn(async () => ({ id: "drupal-fallback-1" }));
  const devProbeWithBearer = vi.fn();
  const devInvalidateProbeCache = vi.fn();
  const deps = {
    drupal: {
      listInstances,
      saveInstance,
      devPersistLocalInstanceUnvalidated,
      devProbeWithBearer,
      devInvalidateProbeCache,
    },
    widgetAuth: {
      read: vi.fn(() => ({ apiKey: WIDGET_UUID, generatedAt: "now" })),
      generate: vi.fn(() => ({ apiKey: WIDGET_UUID, generatedAt: "now" })),
    },
    nango: {
      isNangoConfigured,
      getNangoCredentials,
      ensureNangoConnectorIntegration,
      providerConfigKeys: { drupal: "cinatra-drupal" },
    },
    helpers: {
      probeDockerContainer: vi.fn(() => true),
      probeHttp: vi.fn(() => true),
      probeHttpAnswered: vi.fn(() => true),
      probeHttpReachableWithRetry: vi.fn(async () => true),
      dockerExecCapture: docker,
      isLocalhostUrl: vi.fn(() => true),
      trimTrailingSlashes: (input: string) => {
        let end = input.length;
        while (end > 0 && input.charCodeAt(end - 1) === 47) end--;
        return input.slice(0, end);
      },
    },
    log: vi.fn(),
    mintDevConnectCredential: vi.fn(() => null),
    browserBaseUrl: "http://localhost:3000",
  } as unknown as DrupalDevSetupDeps;
  return {
    deps,
    docker,
    getNangoCredentials,
    isNangoConfigured,
    ensureNangoConnectorIntegration,
    saveInstance,
    listInstances,
    devPersistLocalInstanceUnvalidated,
    devProbeWithBearer,
    devInvalidateProbeCache,
  };
}

/** Count the drush mint invocations among the argv-based docker execs. */
function mintCalls(docker: ReturnType<typeof vi.fn>): number {
  return docker.mock.calls.filter((c) => Array.isArray(c[1]) && c[1].includes("mcp-tools:remote-key-create")).length;
}

const drupalInput = {
  instanceId: "drupal-1",
  instanceName: "Local Drupal",
  siteUrl: "http://localhost:8082",
  widgetApiKey: WIDGET_UUID,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// parseDrupalRemoteKey — ReDoS-safe porcelain extraction (relocated verbatim)
// ===========================================================================

describe("parseDrupalRemoteKey", () => {
  it("returns the trailing token line", () => {
    expect(parseDrupalRemoteKey(`some log\n${FRESH_BEARER}`)).toBe(FRESH_BEARER);
  });

  it("returns the token when it is the only line", () => {
    expect(parseDrupalRemoteKey(FRESH_BEARER)).toBe(FRESH_BEARER);
  });

  it("rejects a trailing human log line (no clean token)", () => {
    expect(parseDrupalRemoteKey(`${FRESH_BEARER}\n[notice] key created.`)).toBeNull();
  });

  it("extracts the labeled `API Key:` line despite the trailing human notice (mcp_tools 1.0.0-beta14)", () => {
    const out = [
      "[notice] Created new remote API key.",
      ` API Key: ${FRESH_BEARER}`,
      "Store this API key now; it cannot be shown again.",
    ].join("\n");
    expect(parseDrupalRemoteKey(out)).toBe(FRESH_BEARER);
  });

  it("rejects a labeled `API Key:` line whose value is not token-shaped", () => {
    expect(parseDrupalRemoteKey("API Key: not a single token")).toBeNull();
  });

  it("stays linear on newline-heavy input for the labeled parse (ReDoS guard)", () => {
    const evil = " \n".repeat(80_000) + "API Key";
    const start = Date.now();
    expect(parseDrupalRemoteKey(evil)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("rejects a token shorter than 16 chars", () => {
    expect(parseDrupalRemoteKey("short")).toBeNull();
  });

  it("rejects empty / whitespace-only output", () => {
    expect(parseDrupalRemoteKey("\n   \n")).toBeNull();
  });

  it("does not catastrophically backtrack on a long non-token line (ReDoS guard)", () => {
    const evil = `${"a".repeat(50_000)} !`; // contains a space → not a single token
    const start = Date.now();
    expect(parseDrupalRemoteKey(evil)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// ===========================================================================
// Drupal reconcile
// ===========================================================================

describe("ensureDrupalRemoteKeyReconciled", () => {
  it("REUSE on a valid probe — no mint, no rotate, no cache eviction", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ apiKey: STORED_BEARER });
    t.devProbeWithBearer.mockResolvedValueOnce("registered");

    const r = await ensureDrupalRemoteKeyReconciled(t.deps, drupalInput);

    expect(r).toMatchObject({ working: true, rotated: false });
    expect(mintCalls(t.docker)).toBe(0); // no drush mint
    expect(t.saveInstance).not.toHaveBeenCalled();
    expect(t.devInvalidateProbeCache).not.toHaveBeenCalled();
  });

  it("ROTATE only on a definite 401/403 (auth_error) — mints + re-imports + evicts cache", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ apiKey: STORED_BEARER });
    t.devProbeWithBearer.mockResolvedValueOnce("auth_error");
    t.docker.mockReturnValueOnce({ code: 0, out: FRESH_BEARER });

    const r = await ensureDrupalRemoteKeyReconciled(t.deps, drupalInput);

    expect(r).toMatchObject({ working: true, rotated: true });
    expect(mintCalls(t.docker)).toBe(1);
    expect(t.saveInstance).toHaveBeenCalledWith(
      expect.objectContaining({ id: "drupal-1", mcpApiKey: FRESH_BEARER }),
    );
    expect(t.devInvalidateProbeCache).toHaveBeenCalledWith(drupalInput.siteUrl);
  });

  it("ROTATE on legacy split-brain (stored value === widget UUID) without even probing", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ apiKey: WIDGET_UUID });
    t.docker.mockReturnValueOnce({ code: 0, out: FRESH_BEARER });

    const r = await ensureDrupalRemoteKeyReconciled(t.deps, drupalInput);

    expect(r).toMatchObject({ working: true, rotated: true });
    expect(t.devProbeWithBearer).not.toHaveBeenCalled(); // short-circuits to rotate
    expect(t.saveInstance).toHaveBeenCalledWith(expect.objectContaining({ mcpApiKey: FRESH_BEARER }));
  });

  it("NO rotate on unreachable (transient) — keeps existing, no mint", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ apiKey: STORED_BEARER });
    t.devProbeWithBearer.mockResolvedValueOnce("unreachable");

    const r = await ensureDrupalRemoteKeyReconciled(t.deps, drupalInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(mintCalls(t.docker)).toBe(0);
    expect(t.saveInstance).not.toHaveBeenCalled();
    expect(t.devInvalidateProbeCache).not.toHaveBeenCalled();
  });

  it("NO rotate on 404 not_installed (transient/non-auth)", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ apiKey: STORED_BEARER });
    t.devProbeWithBearer.mockResolvedValueOnce("not_installed");

    const r = await ensureDrupalRemoteKeyReconciled(t.deps, drupalInput);

    expect(r.rotated).toBe(false);
    expect(mintCalls(t.docker)).toBe(0);
  });

  it("NO mint on an unresolved Nango read (transient) — never mints a duplicate", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce(null);

    const r = await ensureDrupalRemoteKeyReconciled(t.deps, drupalInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(mintCalls(t.docker)).toBe(0);
    expect(t.devProbeWithBearer).not.toHaveBeenCalled();
  });

  it("a FAILED mint never overwrites the working key (no re-import, no rotate)", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ apiKey: STORED_BEARER });
    t.devProbeWithBearer.mockResolvedValueOnce("auth_error");
    // drush returns a human log line, not a clean token → parseDrupalRemoteKey → null
    t.docker.mockReturnValueOnce({ code: 0, out: "[error] could not create" });

    const r = await ensureDrupalRemoteKeyReconciled(t.deps, drupalInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    expect(t.saveInstance).not.toHaveBeenCalled(); // never re-imports a bad key
    expect(t.devInvalidateProbeCache).not.toHaveBeenCalled();
  });

  it("readback-verify: a saveInstance throw (readback mismatch) surfaces as not-working WITHOUT leaking the error text (secret boundary)", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ apiKey: STORED_BEARER });
    t.devProbeWithBearer.mockResolvedValueOnce("auth_error");
    t.docker.mockReturnValueOnce({ code: 0, out: FRESH_BEARER });
    t.saveInstance.mockRejectedValueOnce(new Error(`SENSITIVE-LEAK-${STORED_BEARER}`));

    const r = await ensureDrupalRemoteKeyReconciled(t.deps, drupalInput);

    expect(r).toMatchObject({ working: false, rotated: false });
    // The surfaced note is a FIXED connector-owned label — the raw error never escapes.
    expect(r.note).toMatch(/^re-import-failed/);
    expect(r.note).not.toContain("SENSITIVE-LEAK");
    expect(r.note).not.toContain(STORED_BEARER);
    expect(t.devInvalidateProbeCache).not.toHaveBeenCalled();
  });

  it("a non-zero drush exit yields no key → no rotate", async () => {
    const t = makeDeps();
    t.getNangoCredentials.mockResolvedValueOnce({ apiKey: STORED_BEARER });
    t.devProbeWithBearer.mockResolvedValueOnce("auth_error");
    t.docker.mockReturnValueOnce({ code: 1, out: FRESH_BEARER });

    const r = await ensureDrupalRemoteKeyReconciled(t.deps, drupalInput);

    expect(r.rotated).toBe(false);
    expect(t.saveInstance).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Drupal Nango-decouple — when Nango is NOT configured the localhost first
// wire must STILL land a complete instance row + push the browser widget
// config. SECRET BOUNDARY: assertions only check statuses/calls/fixed labels.
// ===========================================================================
describe("wireLocalDrupalWithoutNango — localhost no-Nango fallback", () => {
  const WIDGET_KEY = "drupal-widget-uuid-pair";

  it("persists a COMPLETE local-dev row BEFORE pushing the widget config; returns created", async () => {
    const t = makeDeps();
    t.listInstances.mockReturnValueOnce([]);
    t.devPersistLocalInstanceUnvalidated.mockResolvedValueOnce({ id: "dr-fallback-1" });

    const r = await wireLocalDrupalWithoutNango(t.deps, WIDGET_KEY);

    expect(r.status).toBe("created");
    expect(t.devPersistLocalInstanceUnvalidated).toHaveBeenCalledWith(
      expect.objectContaining({ siteUrl: "http://localhost:8082", name: expect.any(String) }),
    );
    // The widget config push (3 config:set + cr = 4 drush execs) ran AFTER the
    // persist (persist is awaited before any docker exec).
    expect(t.docker).toHaveBeenCalledTimes(4);
    const argvs = t.docker.mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(argvs.some((a) => a.includes("config:set cinatra.settings cinatra_url"))).toBe(true);
    expect(argvs.some((a) => a.includes("config:set cinatra.settings instance_id dr-fallback-1"))).toBe(true);
  });

  it("re-wire (existing localhost row) is idempotent — reuses the id, returns already-wired", async () => {
    const t = makeDeps();
    t.listInstances.mockReturnValueOnce([
      { id: "dr-existing-1", name: "Local Drupal (dev auto)", siteUrl: "http://localhost:8082" },
    ]);
    t.devPersistLocalInstanceUnvalidated.mockResolvedValueOnce({ id: "dr-existing-1" });

    const r = await wireLocalDrupalWithoutNango(t.deps, WIDGET_KEY);

    expect(r.status).toBe("already-wired");
    // The existing row's id is passed back into the persist (no new uuid).
    expect(t.devPersistLocalInstanceUnvalidated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dr-existing-1" }),
    );
  });

  it("GUARD: a persist failure returns {status:'error'} and pushes NO drush config (never wire a dangling instance_id)", async () => {
    const t = makeDeps();
    t.listInstances.mockReturnValueOnce([]);
    t.devPersistLocalInstanceUnvalidated.mockRejectedValueOnce(new Error("write failed"));

    const r = await wireLocalDrupalWithoutNango(t.deps, WIDGET_KEY);

    expect(r.status).toBe("error");
    if (r.status !== "error") throw new Error("expected error");
    expect(r.reason).toBe("persistLocalDevDrupalInstanceUnvalidated failed (no-Nango first wire)");
    // No widget config was pushed for an unpersisted instance.
    expect(t.docker).not.toHaveBeenCalled();
  });

  it("SECRET BOUNDARY: a drush config:set failure surfaces only a FIXED reason (never the raw argv embedding the api_key)", async () => {
    const t = makeDeps();
    t.listInstances.mockReturnValueOnce([]);
    t.devPersistLocalInstanceUnvalidated.mockResolvedValueOnce({ id: "dr-fallback-2" });
    // The drush invocation embeds the api_key on its argv; a non-zero exit
    // makes drushExec throw its FIXED label.
    t.docker.mockReturnValueOnce({ code: 1, out: `drush config:set cinatra.settings api_key ${WIDGET_KEY} failed` });

    const r = await wireLocalDrupalWithoutNango(t.deps, WIDGET_KEY);

    expect(r.status).toBe("error");
    if (r.status !== "error") throw new Error("expected error");
    expect(r.reason).toBe("drush config:set cinatra.settings failed");
    expect(r.reason).not.toContain(WIDGET_KEY);
  });
});

describe("autoSetupLocalDrupal — Nango branch routing + local-dev transition", () => {
  it("Nango ABSENT on localhost → routes to the no-Nango fallback (persists + pushes config); NEVER skips", async () => {
    const t = makeDeps();
    t.isNangoConfigured.mockReturnValue(false);
    t.listInstances.mockReturnValue([]);
    t.devPersistLocalInstanceUnvalidated.mockResolvedValueOnce({ id: "dr-nofnango-1" });

    const r = await autoSetupLocalDrupal(t.deps);

    expect(r.status).toBe("created");
    expect(t.devPersistLocalInstanceUnvalidated).toHaveBeenCalledTimes(1);
    // The Nango-required happy path was NOT taken.
    expect(t.saveInstance).not.toHaveBeenCalled();
  });

  it("Nango PRESENT → existing path UNCHANGED (reconcile runs; the no-Nango fallback is NOT used)", async () => {
    const t = makeDeps();
    t.isNangoConfigured.mockReturnValue(true);
    t.listInstances.mockReturnValue([
      { id: "dr-1", name: "Local Drupal (dev auto)", siteUrl: "http://localhost:8082" },
    ]);
    // reconcile: stored bearer resolves + probe registered → reuse, working.
    t.getNangoCredentials.mockResolvedValueOnce({ apiKey: STORED_BEARER });
    t.devProbeWithBearer.mockResolvedValueOnce("registered");

    const r = await autoSetupLocalDrupal(t.deps);

    expect(r.status).toBe("already-wired");
    expect(t.devPersistLocalInstanceUnvalidated).not.toHaveBeenCalled();
    expect(t.devProbeWithBearer).toHaveBeenCalledTimes(1);
  });

  it("NANGO-LATER TRANSITION: existing localhost row + Nango now configured + credential-unresolved → preflight + mint + import ONCE", async () => {
    const t = makeDeps();
    t.isNangoConfigured.mockReturnValue(true);
    t.listInstances.mockReturnValue([
      { id: "dr-trans-1", name: "Local Drupal (dev auto)", siteUrl: "http://localhost:8082" },
    ]);
    // reconcile resolves nothing → "credential-unresolved (kept; not minting)".
    t.getNangoCredentials.mockResolvedValueOnce(null);
    // Nango writeability preflight succeeds (default resolves). The mint drush
    // exec returns a fresh key; subsequent execs (widget push) succeed.
    t.docker.mockImplementation((_c: string, args: string[]) =>
      args.includes("mcp-tools:remote-key-create") ? { code: 0, out: FRESH_BEARER } : { code: 0, out: "" },
    );
    t.saveInstance.mockResolvedValueOnce({ id: "dr-trans-1" });

    const r = await autoSetupLocalDrupal(t.deps);

    expect(t.ensureNangoConnectorIntegration).toHaveBeenCalledWith("drupal");
    expect(mintCalls(t.docker)).toBe(1); // minted exactly once
    expect(t.saveInstance).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dr-trans-1", mcpApiKey: FRESH_BEARER }),
    );
    expect(r.status).toBe("already-wired");
  });

  it("NANGO-LATER TRANSITION blocked: Nango configured but preflight UNAVAILABLE (transient outage) → NO mint, NO save", async () => {
    const t = makeDeps();
    t.isNangoConfigured.mockReturnValue(true);
    t.listInstances.mockReturnValue([
      { id: "dr-trans-2", name: "Local Drupal (dev auto)", siteUrl: "http://localhost:8082" },
    ]);
    t.getNangoCredentials.mockResolvedValueOnce(null); // unresolved
    t.ensureNangoConnectorIntegration.mockRejectedValueOnce(new Error("nango unreachable"));

    const r = await autoSetupLocalDrupal(t.deps);

    expect(t.ensureNangoConnectorIntegration).toHaveBeenCalledWith("drupal");
    expect(mintCalls(t.docker)).toBe(0); // never minted on a transient outage
    expect(t.saveInstance).not.toHaveBeenCalled();
    // The wire still completes (widget config re-pushed); MCP write stays 401.
    expect(r.status).toBe("already-wired");
  });

  it("Nango ABSENT + localhost must NOT be a skip — it wires via the fallback", async () => {
    const t = makeDeps();
    t.isNangoConfigured.mockReturnValue(false);
    t.listInstances.mockReturnValue([]);
    t.devPersistLocalInstanceUnvalidated.mockResolvedValueOnce({ id: "dr-local-only" });

    const r = await autoSetupLocalDrupal(t.deps);

    expect(r.status).not.toBe("skipped");
  });
});
