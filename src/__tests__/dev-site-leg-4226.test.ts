// The development-site leg of the Drupal dev setup (cinatra-ai/cinatra#4226,
// cinatra-ai/cinatra#4227): after the module probe, the hook waits for the
// container bootstrap, checks that `cinatra` is enabled, enables the
// `cinatra_dev_site` submodule with the development marker, runs its
// `ensure()` in a separate drush process, and exports the configuration
// whenever the enable succeeded. The leg soft-fails; the instance and widget
// wiring after it runs whatever the leg returned.
//
// SECRET BOUNDARY: assertions check statuses, argv and fixed labels only.

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  autoSetupLocalDrupal,
  ensureLocalDevSite,
  DEV_SITE_WAIT,
  LOCAL_DRUPAL,
  type DrupalDevSetupDeps,
} from "../dev-setup";

const PROBE = ["sh", "-c", "grep -qsz 'cinatra-drupal-entrypoin[t]' /proc/[0-9]*/cmdline; [ $? -eq 1 ]"];
// The probe exits 0 only when grep exited 1 (no command line names the entrypoint); a match or a grep error exits 1.
const IDLE: Answer = { code: 0, out: "" };
const BUSY: Answer = { code: 1, out: "" };
const PM_LIST = ["drush", "--root=/drupal/web", "pm:list", "--status=enabled", "--type=module", "--field=name"];
const ENABLE = ["env", "CINATRA_DEV_SITE=1", "drush", "--root=/drupal/web", "en", "cinatra_dev_site", "-y"];
const ENSURE = [
  "env",
  "CINATRA_DEV_SITE=1",
  "drush",
  "--root=/drupal/web",
  "php:eval",
  "echo json_encode(\\Drupal::service('cinatra_dev_site.ensure')->ensure());",
];
const EXPORT = ["drush", "--root=/drupal/web", "config:export", "--destination=/drupal/config/sync", "-y"];

const ENABLED_LIST = "node\ncinatra\ncontent_moderation\n";
const SECRET = "leg-secret-0123456789abcdef";

type Answer = { code: number; out: string };
type Script = {
  probe?: Answer[];
  pmList?: Answer;
  enable?: Answer;
  ensure?: Answer;
  exportCfg?: Answer;
  throwOn?: "probe" | "enable";
};

const key = (argv: string[]) => argv.join("\u0000");

/** A docker double that answers the leg's argv from the script and every other exec with code 0. */
function docker(script: Script) {
  const probes = [...(script.probe ?? [IDLE])];
  return vi.fn((container: string, argv: string[]): Answer => {
    expect(container).toBe(LOCAL_DRUPAL.containerName);
    const k = key(argv);
    if (k === key(PROBE)) {
      if (script.throwOn === "probe") throw new Error(`SENSITIVE-${SECRET}`);
      return probes.length > 1 ? probes.shift()! : probes[0];
    }
    if (k === key(PM_LIST)) return script.pmList ?? { code: 0, out: ENABLED_LIST };
    if (k === key(ENABLE)) {
      if (script.throwOn === "enable") throw new Error(`SENSITIVE-${SECRET}`);
      return script.enable ?? { code: 0, out: "[success] Module cinatra_dev_site has been installed." };
    }
    if (k === key(ENSURE)) return script.ensure ?? { code: 0, out: '{"ok":true,"refused":[]}\n' };
    if (k === key(EXPORT)) return script.exportCfg ?? { code: 0, out: "[success] Configuration successfully exported." };
    return { code: 0, out: "" };
  });
}

function helpersWith(d: ReturnType<typeof docker>) {
  return {
    probeDockerContainer: vi.fn(() => true),
    probeHttp: vi.fn(() => true),
    probeHttpReachableWithRetry: vi.fn(async () => true),
    dockerExecCapture: d,
    isLocalhostUrl: vi.fn(() => true),
    trimTrailingSlashes: (input: string) => input,
  } as unknown as DrupalDevSetupDeps["helpers"];
}

/** The leg's own drush steps, in call order (the bootstrap probe and the wiring left out). */
function legSteps(d: ReturnType<typeof docker>): string[] {
  const names = new Map([
    [key(PM_LIST), "pm:list"],
    [key(ENABLE), "en"],
    [key(ENSURE), "ensure"],
    [key(EXPORT), "export"],
  ]);
  return d.mock.calls.map((c) => names.get(key(c[1] as string[]))).filter((n): n is string => !!n);
}

function probeCount(d: ReturnType<typeof docker>): number {
  return d.mock.calls.filter((c) => key(c[1] as string[]) === key(PROBE)).length;
}

const noSleep = () => vi.fn(async (_ms: number) => {});

/** Full hook deps: no Nango, localhost, no existing instance (the first wire). */
function hookDeps(script: Script) {
  const d = docker(script);
  const log = vi.fn();
  const deps = {
    drupal: {
      listInstances: vi.fn(() => []),
      saveInstance: vi.fn(async () => ({ id: "drupal-1" })),
      devPersistLocalInstanceUnvalidated: vi.fn(async () => ({ id: "drupal-dev-1" })),
    },
    widgetAuth: {
      read: vi.fn(() => ({ apiKey: "widget-uuid", generatedAt: "now" })),
      generate: vi.fn(() => ({ apiKey: "widget-uuid", generatedAt: "now" })),
    },
    nango: {
      isNangoConfigured: vi.fn(() => false),
      getNangoCredentials: vi.fn(),
      ensureNangoConnectorIntegration: vi.fn(async () => null),
      providerConfigKeys: { drupal: "cinatra-drupal" },
    },
    helpers: helpersWith(d),
    log,
    mintDevConnectCredential: vi.fn(() => null),
    browserBaseUrl: "http://localhost:3000",
  } as unknown as DrupalDevSetupDeps;
  return { deps, d, log };
}

function configSetCalls(d: ReturnType<typeof docker>): number {
  return d.mock.calls.filter((c) => (c[1] as string[]).includes("config:set")).length;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureLocalDevSite: the steps and their order", () => {
  it("runs pm:list, en, ensure and export in that order after an idle probe, and reports armed", async () => {
    const d = docker({});
    const out = await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() });
    expect(out).toEqual({ state: "armed" });
    expect(probeCount(d)).toBe(1);
    expect(legSteps(d)).toEqual(["pm:list", "en", "ensure", "export"]);
  });

  it("passes the development marker to en and to the ensure process only", async () => {
    const d = docker({});
    await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() });
    const argvs = d.mock.calls.map((c) => c[1] as string[]);
    expect(argvs).toContainEqual(ENABLE);
    expect(argvs).toContainEqual(ENSURE);
    const marked = argvs.filter((a) => a.includes("CINATRA_DEV_SITE=1"));
    expect(marked).toEqual([ENABLE, ENSURE]);
  });

  it("the default wait is bounded (attempts and interval are positive and finite)", () => {
    expect(DEV_SITE_WAIT.attempts).toBeGreaterThan(0);
    expect(DEV_SITE_WAIT.intervalMs).toBeGreaterThan(0);
    expect(DEV_SITE_WAIT.attempts * DEV_SITE_WAIT.intervalMs).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});

describe("ensureLocalDevSite: the bootstrap wait", () => {
  it("waits while the entrypoint bootstrap runs, then continues", async () => {
    const d = docker({ probe: [BUSY, BUSY, IDLE] });
    const sleep = noSleep();
    const out = await ensureLocalDevSite(helpersWith(d), { sleep, attempts: 5, intervalMs: 7 });
    expect(out).toEqual({ state: "armed" });
    expect(probeCount(d)).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7);
    expect(legSteps(d)).toEqual(["pm:list", "en", "ensure", "export"]);
  });

  it("soft-skips with a fixed reason when the bootstrap never ends within the attempts, and runs no drush step", async () => {
    const d = docker({ probe: [BUSY] });
    const sleep = noSleep();
    const out = await ensureLocalDevSite(helpersWith(d), { sleep, attempts: 4, intervalMs: 5 });
    expect(out).toEqual({
      state: "skipped",
      reason: "the Drupal container bootstrap still runs; the development site leg did not run",
    });
    expect(probeCount(d)).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(legSteps(d)).toEqual([]);
  });

  it.each([
    ["exit 1", 1],
    ["exit 2", 2],
    ["exit 127", 127],
  ])("every non-zero probe exit counts as busy (%s)", async (_name, code) => {
    const d = docker({ probe: [{ code, out: "" }, IDLE] });
    const sleep = noSleep();
    const out = await ensureLocalDevSite(helpersWith(d), { sleep, attempts: 3, intervalMs: 5 });
    expect(out).toEqual({ state: "armed" });
    expect(probeCount(d)).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("zero attempts probe nothing and soft-skip", async () => {
    const d = docker({});
    const out = await ensureLocalDevSite(helpersWith(d), { sleep: noSleep(), attempts: 0 });
    expect(out).toMatchObject({ state: "skipped" });
    expect(probeCount(d)).toBe(0);
    expect(legSteps(d)).toEqual([]);
  });
});

describe("ensureLocalDevSite: cinatra must be enabled", () => {
  const skipped = {
    state: "skipped",
    reason: "the cinatra module is not enabled; the development site leg did not run",
  };

  it("soft-skips when pm:list does not list cinatra", async () => {
    const d = docker({ pmList: { code: 0, out: "node\ncontent_moderation\n" } });
    expect(await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() })).toEqual(skipped);
    expect(legSteps(d)).toEqual(["pm:list"]);
  });

  it("reads whole lines: cinatra_dev_site or a longer name does not count as cinatra", async () => {
    const d = docker({ pmList: { code: 0, out: "cinatra_dev_site\ncinatra_extra\nnot_cinatra\n" } });
    expect(await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() })).toEqual(skipped);
    expect(legSteps(d)).toEqual(["pm:list"]);
  });

  it("accepts the name with surrounding blanks and a carriage return", async () => {
    const d = docker({ pmList: { code: 0, out: "node\r\n  cinatra  \r\n" } });
    expect(await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() })).toEqual({ state: "armed" });
  });

  it("soft-skips when pm:list fails, even if its output names cinatra", async () => {
    const d = docker({ pmList: { code: 1, out: "cinatra\n" } });
    expect(await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() })).toEqual(skipped);
    expect(legSteps(d)).toEqual(["pm:list"]);
  });
});

describe("ensureLocalDevSite: enable, ensure and export", () => {
  it("a failed en is an error; nothing runs after it (no ensure, no export)", async () => {
    const d = docker({ enable: { code: 1, out: `[error] ${SECRET}` } });
    const out = await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() });
    expect(out).toEqual({ state: "error", reason: "drush en cinatra_dev_site failed; the development site is not armed" });
    expect(legSteps(d)).toEqual(["pm:list", "en"]);
  });

  it("ensure() answering ok false is an error, and the export still runs", async () => {
    const d = docker({ ensure: { code: 0, out: `{"ok":false,"refused":["no_marker","${SECRET}"]}` } });
    const out = await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() });
    expect(out).toEqual({
      state: "error",
      reason: "cinatra_dev_site ensure() did not report ok; the development site is not armed",
    });
    expect(legSteps(d)).toEqual(["pm:list", "en", "ensure", "export"]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("a failed ensure process is an error, and the export still runs", async () => {
    const d = docker({ ensure: { code: 255, out: '{"ok":true}' } });
    const out = await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() });
    expect(out).toMatchObject({ state: "error" });
    expect(legSteps(d)).toEqual(["pm:list", "en", "ensure", "export"]);
  });

  it.each([
    ["no JSON", "PHP Fatal error: Uncaught exception"],
    ["ok as a string", '{"ok":"true"}'],
    ["ok as a number", '{"ok":1}'],
    ["no ok key", '{"refused":[]}'],
    ["a JSON list", "[true]"],
    ["empty output", ""],
  ])("only ok === true counts (%s)", async (_name, outText) => {
    const d = docker({ ensure: { code: 0, out: outText } });
    const out = await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() });
    expect(out).toEqual({
      state: "error",
      reason: "cinatra_dev_site ensure() did not report ok; the development site is not armed",
    });
  });

  it("reads the last JSON line of the output (notices before it are ignored)", async () => {
    const d = docker({ ensure: { code: 0, out: '[notice] Rebuilt the router.\n{"ok":false}\n{"ok":true,"refused":[]}\n\n' } });
    expect(await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() })).toEqual({ state: "armed" });
  });

  it("a line that starts with { but is no JSON is passed over", async () => {
    const d = docker({ ensure: { code: 0, out: '{"ok":true}\n{"ok": tru' } });
    expect(await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() })).toEqual({ state: "armed" });
  });

  it("a later ok false line decides over an earlier ok true line", async () => {
    const d = docker({ ensure: { code: 0, out: '{"ok":true}\n{"ok":false}\n[notice] done' } });
    expect(await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() })).toMatchObject({ state: "error" });
  });

  it("an armed site whose export fails is an error", async () => {
    const d = docker({ exportCfg: { code: 1, out: `[error] ${SECRET}` } });
    const out = await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() });
    expect(out).toEqual({
      state: "error",
      reason: "drush config:export failed after cinatra_dev_site was enabled; the sync directory was not refreshed",
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("ensure() not ok and a failed export name both failures", async () => {
    const d = docker({ ensure: { code: 0, out: '{"ok":false}' }, exportCfg: { code: 1, out: "" } });
    expect(await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() })).toEqual({
      state: "error",
      reason:
        "cinatra_dev_site ensure() did not report ok; the development site is not armed; " +
        "drush config:export failed after cinatra_dev_site was enabled; the sync directory was not refreshed",
    });
  });

  it("a throwing helper resolves to a fixed error and never rejects", async () => {
    const d = docker({ throwOn: "enable" });
    const out = await ensureLocalDevSite(helpersWith(d), { sleep: noSleep() });
    expect(out).toEqual({ state: "error", reason: "the development site leg failed unexpectedly" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe("autoSetupLocalDrupal with the development-site leg", () => {
  it("runs the leg before the widget wiring and keeps the wiring status when the leg arms", async () => {
    const h = hookDeps({});
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status).toMatchObject({ status: "created", siteUrl: LOCAL_DRUPAL.siteUrl });
    const argvs = h.d.mock.calls.map((c) => key(c[1] as string[]));
    const exportAt = argvs.indexOf(key(EXPORT));
    const firstConfigSet = h.d.mock.calls.findIndex((c) => (c[1] as string[]).includes("config:set"));
    expect(exportAt).toBeGreaterThanOrEqual(0);
    expect(firstConfigSet).toBeGreaterThan(exportAt);
    expect(h.log).toHaveBeenCalledWith("development site armed (cinatra_dev_site ensure() ok; configuration exported).");
  });

  it("the leg runs after the module probe: a missing module clone skips before any leg step", async () => {
    const h = hookDeps({});
    h.d.mockImplementation((_c: string, argv: string[]) =>
      argv.join(" ").includes("test -f /drupal/web/modules/custom/cinatra/cinatra.module")
        ? { code: 1, out: "" }
        : { code: 0, out: "" },
    );
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status).toMatchObject({ status: "skipped" });
    expect(probeCount(h.d)).toBe(0);
  });

  it("a skipped leg leaves the status unchanged and logs its fixed reason", async () => {
    const h = hookDeps({ pmList: { code: 0, out: "node\n" } });
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status).toMatchObject({ status: "created" });
    expect(h.log).toHaveBeenCalledWith(
      "development site leg: the cinatra module is not enabled; the development site leg did not run",
    );
  });

  it("a leg error fails the boot status with the leg's fixed reason, after the wiring ran", async () => {
    const h = hookDeps({ ensure: { code: 0, out: `{"ok":false,"refused":["${SECRET}"]}` } });
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status).toEqual({
      status: "error",
      reason:
        "cinatra_dev_site ensure() did not report ok; the development site is not armed " +
        "(the instance and widget wiring completed: created)",
    });
    expect(configSetCalls(h.d)).toBe(3);
    expect(h.deps.drupal.devPersistLocalInstanceUnvalidated).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it("a throwing leg does not stop the wiring", async () => {
    const h = hookDeps({ throwOn: "probe" });
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status).toEqual({
      status: "error",
      reason: "the development site leg failed unexpectedly (the instance and widget wiring completed: created)",
    });
    expect(configSetCalls(h.d)).toBe(3);
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it("a wiring skip keeps its own status over a leg error", async () => {
    const h = hookDeps({ enable: { code: 1, out: "" } });
    (h.deps.helpers.isLocalhostUrl as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status).toEqual({ status: "skipped", reason: "Nango not configured (run cinatra setup nango first)" });
  });

  it("a wiring error keeps its own reason over a leg error", async () => {
    const h = hookDeps({ enable: { code: 1, out: "" } });
    (h.deps.drupal.devPersistLocalInstanceUnvalidated as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("write failed"),
    );
    const status = await autoSetupLocalDrupal(h.deps);
    expect(status).toEqual({
      status: "error",
      reason: "persistLocalDevDrupalInstanceUnvalidated failed (no-Nango first wire)",
    });
    expect(h.log).toHaveBeenCalledWith(
      "development site leg: drush en cinatra_dev_site failed; the development site is not armed",
    );
  });
});
