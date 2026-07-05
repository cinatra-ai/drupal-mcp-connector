// Connector-owned dev-mode provisioning hook (cinatra-ai/cinatra#976, epic
// #978 wave W-D) — the Drupal block relocated VERBATIM-in-behavior from the
// host's `src/lib/dev-auto-setup.ts` behind the `cinatra.devSetup` manifest
// hook. The host's dev-only shell invokes `runDevSetup(ctx)` idempotently on
// every dev boot; the docker fixture itself (`docker/drupal`, entrypoint)
// stays host-side as the integration harness.
//
// Goal: after a fresh `pnpm dev` (or `cinatra setup dev`) with the local
// docker Drupal (http://localhost:8082) running, the assistant can read/write
// Drupal without ANY manual configuration on either side.
//
// Idempotent. Soft-fails (returns a status object) — never throws — so app
// boot is never blocked by a drush hiccup. SECRET BOUNDARY: the minted
// `mcp_tools_remote` Bearer / widget `cnx_` are never logged; failure reasons
// are fixed connector-owned labels (never a lower-layer error text).
//
// SDK imports are TYPE-ONLY (host-peer value-import ban); the host services
// resolve at call time through the capability port on the hook context.

import { existsSync } from "node:fs";
import path from "node:path";

import type {
  ExtensionDevSetupContext,
  ExtensionDevSetupHelpers,
  ExtensionDevSetupStatus,
  HostDrupalMcpService,
  HostDrupalWidgetAuthService,
  NangoSystemSurface,
} from "@cinatra-ai/sdk-extensions";

export const LOCAL_DRUPAL = {
  containerName: "cinatra-drupal-1",
  siteUrl: "http://localhost:8082",
  instanceName: "Local Drupal (dev auto)",
} as const;

const DRUPAL_REMOTE_KEY_LABEL = "cinatra-dev";

/** The narrow host-service slice this hook consumes (all resolved at run time). */
export type DrupalDevSetupDeps = {
  drupal: Pick<
    HostDrupalMcpService,
    "listInstances" | "saveInstance" | "devPersistLocalInstanceUnvalidated" | "devProbeWithBearer" | "devInvalidateProbeCache"
  >;
  widgetAuth: HostDrupalWidgetAuthService;
  nango: Pick<
    NangoSystemSurface,
    "isNangoConfigured" | "getNangoCredentials" | "ensureNangoConnectorIntegration" | "providerConfigKeys"
  >;
  helpers: ExtensionDevSetupHelpers;
  log: (message: string) => void;
  mintDevConnectCredential: (client: string, widgetOrigin: string) => string | null;
  browserBaseUrl: string;
};

/**
 * Throwing drush exec into the local container (argv-based — no shell string,
 * so credential material never passes through shell interpolation). Throws a
 * FIXED-label error on a non-zero exit — never the raw output/argv.
 */
function drushExec(helpers: ExtensionDevSetupHelpers, args: string[]): void {
  const r = helpers.dockerExecCapture(LOCAL_DRUPAL.containerName, ["drush", "--root=/drupal/web", ...args]);
  if (r.code !== 0) {
    throw new Error(`drush ${args[0] ?? ""} failed (exit ${r.code})`);
  }
}

/** Capture-mode drush exec (combined stdout+stderr) for porcelain reads. */
function drushExecCapture(helpers: ExtensionDevSetupHelpers, args: string[]): { code: number; out: string } {
  return helpers.dockerExecCapture(LOCAL_DRUPAL.containerName, ["drush", "--root=/drupal/web", ...args]);
}

/**
 * Extract the Bearer remote key from `drush mcp-tools:remote-key-create` output.
 *
 * mcp_tools (>= 1.0.0-beta14) prints the key on an explicit `API Key: <token>`
 * line and ENDS the output with a human notice ("Store this API key now; it
 * cannot be shown again.") — so the labeled line is matched first. Older /
 * porcelain-style outputs that end with a bare token line are still accepted
 * as a fallback: the last non-empty trimmed line, only if it is a single
 * opaque token of plausible length. Both validation regexes are intentionally
 * LINEAR (anchored both ends, one character class, no nested quantifier) —
 * `js/polynomial-redos` safe. Returns null when neither shape is present
 * (caller soft-skips — a failed mint must NEVER overwrite a working key).
 *
 * SECRET BOUNDARY: the returned value is the Bearer; callers must never log it.
 */
export function parseDrupalRemoteKey(out: string): string | null {
  // Labeled form first: `API Key: <token>` on its own line (current mcp_tools;
  // its trailing human notice would otherwise defeat the trailing-token parse).
  // Whitespace is HORIZONTAL-only ([ \t], not \s): under /m a `^\s*` could
  // consume newlines and backtrack across line starts on newline-heavy input
  // (superlinear); anchored horizontal runs keep the scan linear per line.
  const labeled = out.match(/^[ \t]*API Key:[ \t]*([A-Za-z0-9._=+/-]{16,512})[ \t]*$/m);
  if (labeled) return labeled[1];
  const lines = out.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    // A valid remote key is a single opaque token (no whitespace), reasonable
    // length. `[A-Za-z0-9._=+/-]` is a single character class; the bounded
    // quantifier `{16,512}` is anchored and non-nested → linear, ReDoS-safe.
    if (/^[A-Za-z0-9._=+/-]{16,512}$/.test(line)) return line;
    // First non-empty line from the bottom that isn't token-shaped (e.g. a
    // human log line) means the porcelain token wasn't the last line — stop:
    // we only trust a clean trailing token.
    return null;
  }
  return null;
}

/**
 * Mint a fresh Drupal `mcp_tools_remote` Bearer via drush, returning the opaque
 * key or null on any failure. Never throws; never logs the key.
 */
function mintDrupalRemoteKey(helpers: ExtensionDevSetupHelpers): string | null {
  try {
    const r = drushExecCapture(helpers, [
      "mcp-tools:remote-key-create",
      `--label=${DRUPAL_REMOTE_KEY_LABEL}`,
      "--scopes=read,write",
    ]);
    if (r.code !== 0) return null;
    return parseDrupalRemoteKey(r.out);
  } catch {
    return null;
  }
}

export type DrupalReconcileOutcome = {
  // The reconcile reached a state where the stored Nango Bearer should
  // authenticate against Drupal `/_mcp_tools` (reused-OK, kept-on-transient, or
  // freshly minted + readback-verified). False = the connector will 401.
  working: boolean;
  rotated: boolean;
  note?: string;
};

/**
 * Reconcile the Drupal Nango connection's stored credential to the value
 * Drupal's `mcp_tools_remote` actually validates — the
 * `drush mcp-tools:remote-key-create` Bearer — NOT the cinatra widget UUID
 * the connection stored historically (split-brain).
 *
 * Reuse-first / probe-then-rotate:
 *   1. Resolve the stored Bearer from Nango (forceRefresh — bypass the cred
 *      cache). If unresolved (null/throw) → TRANSIENT: keep, soft-skip (never
 *      mint on a transient Nango blip).
 *   2. Legacy split-brain: if the stored value is EXACTLY the widget UUID, the
 *      connection holds the wrong secret → rotate.
 *   3. Otherwise probe `/_mcp_tools` with the stored Bearer (live,
 *      cache-bypassing). Rotate ONLY on a definite `auth_error` (401/403).
 *      `registered` → reuse; `not_installed`/`unreachable` → keep + soft-skip.
 *   4. Rotate = mint a fresh key, then re-import via the host's `saveInstance`
 *      (which readback-verifies the new key in Nango BEFORE it persists, so a
 *      failed mint/import can never overwrite the working stored key). On
 *      success, invalidate the URL-keyed probe cache.
 *
 * Soft-fails: never throws. SECRET BOUNDARY: only statuses/booleans surfaced.
 */
export async function ensureDrupalRemoteKeyReconciled(
  deps: DrupalDevSetupDeps,
  input: {
    instanceId: string;
    instanceName: string;
    siteUrl: string;
    widgetApiKey: string;
  },
): Promise<DrupalReconcileOutcome> {
  const providerConfigKey = deps.nango.providerConfigKeys.drupal;

  const rotate = async (reason: string): Promise<DrupalReconcileOutcome> => {
    const minted = mintDrupalRemoteKey(deps.helpers);
    if (!minted) {
      // Mint failed — keep the existing stored credential untouched.
      return { working: false, rotated: false, note: `mint-failed (${reason}; kept existing)` };
    }
    try {
      // saveInstance does ensure → import → forceRefresh readback-verify
      // (throws on mismatch) → persist. The readback gate means a bad key
      // never lands in the local row/pointer.
      await deps.drupal.saveInstance({
        id: input.instanceId,
        name: input.instanceName,
        siteUrl: input.siteUrl,
        mcpApiKey: minted,
      });
    } catch {
      // SECRET BOUNDARY: do NOT forward the raw error message — the save can
      // carry lower-layer (Nango import / readback) text. Fixed label only.
      return { working: false, rotated: false, note: `re-import-failed (${reason})` };
    }
    // Rotation succeeded: evict the URL-keyed probe cache so the next
    // UI/injection probe re-evaluates against the fresh Bearer.
    deps.drupal.devInvalidateProbeCache?.(input.siteUrl);
    return { working: true, rotated: true, note: `rotated (${reason})` };
  };

  // 1. Resolve the stored Bearer (forceRefresh — bypass the cred cache).
  let storedBearer: string | null;
  try {
    const cred = await deps.nango.getNangoCredentials(providerConfigKey, input.instanceId, {
      forceRefresh: true,
    });
    storedBearer =
      cred && typeof cred === "object" && "apiKey" in cred
        ? (((cred as { apiKey?: unknown }).apiKey as string | undefined) ?? null)
        : typeof cred === "string"
          ? cred
          : null;
  } catch {
    // Transient Nango read failure — keep, do NOT mint a duplicate.
    return { working: false, rotated: false, note: "credential-resolve-error (kept existing)" };
  }

  if (!storedBearer) {
    // Could be a transient null OR a genuinely missing credential. With an
    // existing instance present we do NOT mint on an unresolved read (avoids
    // minting a fresh key every boot on a Nango blip).
    return { working: false, rotated: false, note: "credential-unresolved (kept; not minting)" };
  }

  // 2. Legacy split-brain — the connection literally stores the widget UUID.
  //    Exact equality (NOT a UUID-shape regex): if the historical wrong value
  //    is present, it can never validate against `mcp_tools_remote` → rotate.
  if (storedBearer === input.widgetApiKey) {
    return rotate("split-brain: widget-uuid stored");
  }

  // 3. Probe live with the stored Bearer (cache-bypassing).
  const status = deps.drupal.devProbeWithBearer
    ? await deps.drupal.devProbeWithBearer(input.siteUrl, storedBearer)
    : "unreachable";
  if (status === "registered") {
    return { working: true, rotated: false };
  }
  if (status === "auth_error") {
    // Definite 401/403 — the stored key is genuinely stale → rotate.
    return rotate("probe-401/403");
  }
  // not_installed (404) / unreachable (timeout/5xx/network): NEVER rotate on a
  // transient or non-auth condition — keep the existing key, soft-skip.
  return { working: false, rotated: false, note: `probe-${status} (kept existing; not rotating)` };
}

/**
 * Push the Drupal browser widget config via drush (idempotent — `config:set`
 * is a no-op when unchanged). `cinatra_url` is the BROWSER-reachable origin
 * (localhost:PORT) — the widget bundle + SSE load from it in the admin's
 * browser. All values are controlled (localhost:PORT + UUIDs).
 *
 * SECRET BOUNDARY: the api_key is on the drush argv; callers MUST catch and
 * surface only a fixed connector-owned reason. This helper does not log.
 *
 * cinatra#410 — in dev, push a real per-site `cnx_` connect-site credential
 * (bound to the host-seeded dev actor's org, the Drupal browser origin) so
 * the widget's broker can drive the genuine cit_/cwu_ auth path; fall back to
 * the passed legacy UUID when the dev mint is unavailable.
 */
function pushDrupalWidgetConfig(deps: DrupalDevSetupDeps, widgetApiKey: string, instanceId: string): void {
  const key = deps.mintDevConnectCredential("drupal", LOCAL_DRUPAL.siteUrl) || widgetApiKey;
  drushExec(deps.helpers, ["config:set", "cinatra.settings", "cinatra_url", deps.browserBaseUrl, "-y"]);
  drushExec(deps.helpers, ["config:set", "cinatra.settings", "api_key", key, "-y"]);
  drushExec(deps.helpers, ["config:set", "cinatra.settings", "instance_id", instanceId, "-y"]);
  drushExec(deps.helpers, ["cr"]);
}

/**
 * LOCALHOST + NO-NANGO fallback wire for Drupal (mirrors the WP first-wire).
 * Lands a COMPLETE local-dev instance row WITHOUT any Nango side effect, then
 * pushes the browser widget config so the widget wires. The MCP write path
 * stays unconfigured (writes 401) until Nango is configured — the next boot's
 * local-dev transition then mints + imports the remote-key Bearer.
 *
 * GUARD: never push the widget config for an instance row we did not actually
 * persist — a `config:set instance_id` pointing at no configured-instance row
 * would dangle (widget-stream auth has no instance to authorize). So a persist
 * failure returns a hard `error` and pushes NOTHING.
 *
 * SECRET BOUNDARY: no vault credential is involved (the widget api_key is a
 * UUID pair); failure reasons are fixed connector-owned labels.
 */
export async function wireLocalDrupalWithoutNango(
  deps: DrupalDevSetupDeps,
  widgetApiKey: string,
): Promise<ExtensionDevSetupStatus> {
  const existing = (await deps.drupal.listInstances()).find((i) => i.siteUrl === LOCAL_DRUPAL.siteUrl);

  let instanceId: string;
  let created: boolean;
  try {
    const persist = deps.drupal.devPersistLocalInstanceUnvalidated;
    if (!persist) throw new Error("devPersistLocalInstanceUnvalidated unavailable");
    const persisted = await persist({
      id: existing?.id,
      name: existing?.name ?? LOCAL_DRUPAL.instanceName,
      siteUrl: LOCAL_DRUPAL.siteUrl,
    });
    instanceId = persisted.id;
    created = !existing;
  } catch {
    // No COMPLETE instance row landed — hard-error and do NOT push the widget
    // config (a dangling instance_id would never authorize). SECRET BOUNDARY:
    // surface only a fixed connector-owned reason.
    return { status: "error", reason: "persistLocalDevDrupalInstanceUnvalidated failed (no-Nango first wire)" };
  }

  try {
    pushDrupalWidgetConfig(deps, widgetApiKey, instanceId);
  } catch {
    // SECRET BOUNDARY: see pushDrupalWidgetConfig — never forward the raw error.
    return { status: "error", reason: "drush config:set cinatra.settings failed" };
  }

  deps.log(
    "Nango not configured; persisted a local-dev instance + pushed the widget config anyway. " +
      "Drupal MCP writes 401 until Nango is configured; the next boot mints + imports the remote-key.",
  );

  const note = "widget wired; MCP remote-key unconfigured (no Nango)";
  return created
    ? { status: "created", siteUrl: LOCAL_DRUPAL.siteUrl, detail: `instance ${instanceId} (${note})` }
    : {
        status: "already-wired",
        siteUrl: LOCAL_DRUPAL.siteUrl,
        detail: `instance ${instanceId} (config re-pushed; ${note})`,
      };
}

/**
 * The Drupal auto-setup body (exported for tests; `runDevSetup` wraps it with
 * capability resolution).
 */
export async function autoSetupLocalDrupal(
  deps: DrupalDevSetupDeps,
): Promise<ExtensionDevSetupStatus> {
  const { helpers } = deps;
  if (!helpers.probeDockerContainer(LOCAL_DRUPAL.containerName)) {
    return {
      status: "skipped",
      reason: `${LOCAL_DRUPAL.containerName} not running (run docker compose --profile drupal up -d)`,
    };
  }
  // Resilient reachability: the container is up + `drush`-ready (the readiness
  // gate confirms `pm:list` INSIDE the container), but Drupal's external Apache
  // can still be settling after `site:install` / an Apache restart. Retry with
  // bounded backoff and accept ANY HTTP answer (a fresh Drupal serves a
  // redirect / non-2xx before it stabilises) instead of skipping on the first
  // miss. Soft-skip only after the whole window is exhausted.
  if (!(await helpers.probeHttpReachableWithRetry(LOCAL_DRUPAL.siteUrl + "/"))) {
    return {
      status: "skipped",
      reason: `${LOCAL_DRUPAL.siteUrl} not reachable (after bounded retries; Apache may still be settling)`,
    };
  }

  // The Drupal module is consumed as a local clone of cinatra-ai/drupal-module
  // (synced by `cinatra setup dev`). Skip cleanly if it hasn't been cloned yet.
  if (!existsSync(path.join(process.cwd(), "dev/drupal-module/cinatra/cinatra.module"))) {
    return {
      status: "skipped",
      reason: "module clone missing at dev/drupal-module/cinatra/cinatra.module. Run `cinatra setup dev` first.",
    };
  }

  // Cinatra-side: generate or reuse the UUID-pair api_key (lives in
  // connector_config:drupal_widget_auth). This is the WIDGET Bearer (the
  // browser→cinatra direction); it is NOT the credential Drupal's
  // `mcp_tools_remote` validates (that is the `drush mcp-tools:remote-key-create`
  // Bearer). The Nango `cinatra-drupal` connection must hold the LATTER.
  const auth = deps.widgetAuth.read() ?? deps.widgetAuth.generate();

  const isLocalhostDrupal = helpers.isLocalhostUrl(LOCAL_DRUPAL.siteUrl);

  // The host's validated `saveInstance` REQUIRES Nango (it imports +
  // readback-verifies a remote-key Bearer into the Nango vault). When Nango is
  // NOT configured, the happy path can't land a configured instance row — but
  // the browser→cinatra WIDGET direction does not depend on it. So on
  // LOCALHOST, fall back to a NON-VALIDATING local-dev persist + push the
  // widget config anyway. OFF localhost we keep refusing (no general
  // production affordance).
  if (!deps.nango.isNangoConfigured()) {
    if (!isLocalhostDrupal) {
      return { status: "skipped", reason: "Nango not configured (run cinatra setup nango first)" };
    }
    return wireLocalDrupalWithoutNango(deps, auth.apiKey);
  }

  // Ensure the cinatra-side instance exists (create on first run; reuse after).
  // On FIRST create, seed the Nango connection with a freshly minted remote-key
  // Bearer (NOT the widget UUID — that historical value was the split-brain
  // bug); if the mint is unavailable, soft-skip the create this boot rather
  // than persist a wrong credential.
  const existing = (await deps.drupal.listInstances()).find((i) => i.siteUrl === LOCAL_DRUPAL.siteUrl);
  let instanceId: string;
  let created: boolean;
  if (existing) {
    instanceId = existing.id;
    created = false;
  } else {
    const seedBearer = mintDrupalRemoteKey(helpers);
    if (!seedBearer) {
      return {
        status: "skipped",
        reason:
          "Drupal mcp-tools:remote-key-create did not yield a key (module may still be installing). " +
          "Re-run once the drupal container has finished provisioning.",
      };
    }
    try {
      const saved = await deps.drupal.saveInstance({
        name: LOCAL_DRUPAL.instanceName,
        siteUrl: LOCAL_DRUPAL.siteUrl,
        mcpApiKey: seedBearer,
      });
      instanceId = saved.id;
      created = true;
    } catch {
      // SECRET BOUNDARY: save errors can carry lower-layer (Nango import /
      // readback) text — surface only a fixed connector-owned reason.
      return { status: "error", reason: "saveDrupalInstance failed (first wire)" };
    }
  }

  // Reconcile the stored Nango Bearer to the value Drupal validates — runs on
  // EVERY wire (create OR reuse). Reuse-first / probe-then-rotate; soft-fails.
  let reconcile = await ensureDrupalRemoteKeyReconciled(deps, {
    instanceId,
    instanceName: existing?.name ?? LOCAL_DRUPAL.instanceName,
    siteUrl: LOCAL_DRUPAL.siteUrl,
    widgetApiKey: auth.apiKey,
  });

  // LOCAL-DEV NANGO-LATER TRANSITION: a row first wired WITHOUT Nango carries
  // `nangoConnectionId=id` but NO actual Nango credential, so the reconcile
  // resolves nothing and — by design — does NOT mint. Unlike WordPress (whose
  // row stores the app password locally and can re-sync Nango from it), a
  // Drupal row keeps no local Bearer, so the ONLY way to heal an unresolved
  // credential once Nango is configured is to mint a fresh remote-key +
  // import it. Gate this to:
  //   - localhost only (dev affordance, never production),
  //   - an EXISTING row (not the first-wire create, which already minted),
  //   - a `credential-unresolved` reconcile note (NOT a probe-401, which the
  //     reconcile already rotates, and NOT probe-unreachable),
  //   - AND a successful Nango writeability PREFLIGHT
  //     (`ensureNangoConnectorIntegration`) — if Nango itself is unreachable,
  //     the unresolved credential is a transient outage: do NOT mint (it would
  //     churn one key per boot, then fail to import).
  if (
    isLocalhostDrupal &&
    existing &&
    !reconcile.working &&
    (reconcile.note ?? "").startsWith("credential-unresolved")
  ) {
    let nangoWriteable = false;
    try {
      await deps.nango.ensureNangoConnectorIntegration("drupal");
      nangoWriteable = true;
    } catch {
      // Nango not actually writeable → the unresolved credential is a transient
      // outage, not a genuine first-time import. Do NOT mint. Keep soft-warn.
    }
    if (nangoWriteable) {
      const minted = mintDrupalRemoteKey(helpers);
      if (minted) {
        try {
          await deps.drupal.saveInstance({
            id: instanceId,
            name: existing.name,
            siteUrl: LOCAL_DRUPAL.siteUrl,
            mcpApiKey: minted,
          });
          reconcile = {
            working: true,
            rotated: true,
            note: "local-dev transition: minted + imported (Nango now configured)",
          };
        } catch {
          // SECRET BOUNDARY: fixed connector-owned note only.
          reconcile = {
            working: false,
            rotated: false,
            note: "local-dev transition: re-import failed (kept; re-run once Drupal is fully up)",
          };
        }
      }
    }
  }

  if (!reconcile.working) {
    deps.log(
      `remote-key reconcile did not confirm a working Bearer (${reconcile.note ?? "unknown"}). ` +
        "Drupal MCP writes 401 until a valid remote key is stored; re-run once Drupal is fully up.",
    );
  }

  // Drupal-side: push the widget config on EVERY run (create OR reuse) so a
  // CMS-volume reset with the app DB retained still re-wires correctly.
  // config:set is a no-op when the value is unchanged. All values are
  // controlled (localhost:PORT + UUIDs).
  try {
    pushDrupalWidgetConfig(deps, auth.apiKey, instanceId);
  } catch {
    // SECRET BOUNDARY: the drush argv embeds the widget api_key — surface only
    // a fixed connector-owned reason, never the raw error.
    return { status: "error", reason: "drush config:set cinatra.settings failed" };
  }

  const reconcileNote = reconcile.rotated
    ? "remote-key rotated"
    : reconcile.working
      ? "remote-key valid"
      : `remote-key unconfirmed (${reconcile.note ?? "unknown"})`;

  return created
    ? { status: "created", siteUrl: LOCAL_DRUPAL.siteUrl, detail: `instance ${instanceId} (${reconcileNote})` }
    : {
        status: "already-wired",
        siteUrl: LOCAL_DRUPAL.siteUrl,
        detail: `instance ${instanceId} (config re-pushed; ${reconcileNote})`,
      };
}

// ---------------------------------------------------------------------------
// Capability resolution (structural narrowing — impls are `unknown` by
// contract; the literals are inlined per the host-peer value-import ban).
// ---------------------------------------------------------------------------

function resolveImpl(ctx: ExtensionDevSetupContext, capability: string): unknown {
  return ctx.capabilities.resolveProviders(capability)[0]?.impl ?? null;
}

function isDrupalMcpService(impl: unknown): impl is HostDrupalMcpService {
  const c = impl as Partial<HostDrupalMcpService> | null;
  return !!c && typeof c === "object" && typeof c.listInstances === "function" && typeof c.saveInstance === "function";
}

function isDrupalWidgetAuthService(impl: unknown): impl is HostDrupalWidgetAuthService {
  const c = impl as Partial<HostDrupalWidgetAuthService> | null;
  return !!c && typeof c === "object" && typeof c.read === "function" && typeof c.generate === "function";
}

function isNangoSystemSurface(impl: unknown): impl is NangoSystemSurface {
  const c = impl as Partial<NangoSystemSurface> | null;
  return (
    !!c &&
    typeof c === "object" &&
    typeof c.isNangoConfigured === "function" &&
    typeof c.getNangoCredentials === "function" &&
    typeof c.ensureNangoConnectorIntegration === "function" &&
    typeof c.providerConfigKeys === "object"
  );
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/** The `cinatra.devSetup` entry point the host's dev-only shell invokes. */
export async function runDevSetup(ctx: ExtensionDevSetupContext): Promise<ExtensionDevSetupStatus> {
  const drupalImpl = resolveImpl(ctx, "@cinatra-ai/host:drupal-mcp");
  const widgetAuthImpl = resolveImpl(ctx, "@cinatra-ai/host:drupal-widget-auth");
  const nangoImpl = resolveImpl(ctx, "nango-system");
  if (!isDrupalMcpService(drupalImpl) || !isDrupalWidgetAuthService(widgetAuthImpl) || !isNangoSystemSurface(nangoImpl)) {
    return { status: "skipped", reason: "host services unresolved (drupal-mcp / drupal-widget-auth / nango-system)" };
  }
  return autoSetupLocalDrupal({
    drupal: drupalImpl,
    widgetAuth: widgetAuthImpl,
    nango: nangoImpl,
    helpers: ctx.helpers,
    log: ctx.log,
    mintDevConnectCredential: ctx.mintDevConnectCredential,
    browserBaseUrl: ctx.browserBaseUrl,
  });
}
