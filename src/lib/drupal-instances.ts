// The Drupal INSTANCE-SETTINGS client — relocated VERBATIM-in-behavior from
// cinatra core's `src/lib/drupal-api.ts` (cinatra#975 Wave 3, epic #978: the
// vendor-publish-direction inversion; the W2 widget-auth precedent).
//
// This connector now OWNS the client. `register.ts` registers it as a provider
// under the SAME existing `@cinatra-ai/host:drupal-mcp` capability id the host
// publishes (a provider-flip — NO sdk-extensions contract change; providers
// coexist keyed by packageName until the single core-eviction PR re-points
// core's registration at this one).
//
// Every former host-internal import is replaced by a PUBLISHED capability,
// resolved LAZILY at call time through the injected deps (probe-safe: building
// the client does no resolution, no I/O):
//   - `@/lib/database` read/write        → the host `connector-config` KV
//     capability (`@cinatra-ai/host:connector-config`) — byte-identical
//     persistence under the same `connector_config:drupal` row.
//   - `@/lib/nango-system`               → the connector-authored `nango-system`
//     surface (ensure/import/credentials/delete/pointer records +
//     `providerConfigKeys`, the same live map core's
//     CINATRA_NANGO_PROVIDER_CONFIG_KEYS proxies).
//   - `@/lib/instance-connection-actor`  → the host
//     `@cinatra-ai/host:instance-connection-gate` service (cinatra#1077):
//     `enforceInstanceConnectionUse` (throws on deny — fail-closed, identical
//     propagation) and `resolveTrustedSessionBinding` (the sanctioned
//     fresh-binding source; same never-throws / both-ids-or-nothing semantics
//     as the former in-repo `resolveActorBindingFromSession`).
//   - `console.warn`                     → the injected `warn` (bound to the
//     ambient `ctx.logger.warn` #981 channel in register.ts); message text —
//     including the `[drupal-api]` label — is kept EXACTLY for log parity.
//
// Deliberate non-byte source change (behavior-identical): the former
// `normalizeSiteUrl` used the anchored greedy `/\/+$/` replace, which core's own
// module marked polynomial-ReDoS (CodeQL `js/polynomial-redos`) with the
// instruction "new code must use the linear form" — this relocated copy IS new
// code, so BOTH call paths now share the linear char-index trim. The output is
// identical for every input.
//
// FAIL-LOUD: a missing capability provider throws through the injected deps
// (register.ts's hostService/nangoSystem resolvers) — never a silent fallback.
// SECRET BOUNDARY: unchanged from core — the mcpApiKey Bearer flows only into
// the Nango import/readback and is never persisted locally nor logged; error
// messages never embed credential material.

import { randomUUID } from "node:crypto";

import type {
  HostInstanceConnectionGateService,
  NangoSystemSurface,
} from "@cinatra-ai/sdk-extensions";

export type DrupalInstanceSettings = {
  id: string;
  name: string;
  siteUrl: string;
  /**
   * Nango connectionId under the cinatra-drupal integration.
   * The Bearer token lives only in the Nango vault and is read via
   * getNangoCredentials at request time.
   */
  nangoConnectionId: string;
  /** Pinned providerConfigKey for forward compatibility. */
  providerConfigKey: string;
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Multi-tenant install→org binding (cinatra#274). Captured from the
   * configuring admin's session at save time:
   *   • orgId — the admin's active organization id,
   *   • runBy — the admin's user id (the OBO write actor for this install).
   * Resolved by the host's `resolveContentEditorIdentityForInstance` so a
   * host-initiated content-editor write executes as THIS install's org/user
   * instead of the single-tenant default. Persisted as part of the drupal
   * connector_config JSON blob — no schema migration. Undefined on rows saved
   * before this change (pre-binding) and on the session-less local-dev
   * persist — the resolver then falls back to single-tenant identity.
   */
  orgId?: string;
  runBy?: string;
};

export type DrupalAPISettings = {
  instances: DrupalInstanceSettings[];
};

export type DrupalAPIStatus = {
  instanceCount: number;
  instances: Array<{ id: string; name: string; siteUrl: string; lastValidatedAt?: string }>;
};

export type SaveDrupalInstanceInput = {
  id?: string;
  name: string;
  siteUrl: string;
  /**
   * Bearer token (from `drush mcp-tools:remote-key-create`).
   * - REQUIRED for new instances.
   * - OPTIONAL for edits; when blank, the existing Nango credential is
   *   preserved and only the name/URL changes.
   */
  mcpApiKey?: string;
  /**
   * Multi-tenant install→org binding (cinatra#274). The Drupal save action is
   * a manage-gated "use server" action with no session object of its own — so
   * these fields are OPTIONAL. When the caller does not pass them,
   * `saveDrupalInstance` captures the configuring admin's {orgId, runBy} from
   * the current request session via the host instance-connection-gate's
   * `resolveTrustedSessionBinding` (the only sanctioned fresh-binding source),
   * and leaves the binding untouched when there is no session (e.g. local-dev
   * / dev-auto-setup). Preserved on edit-without-binding; never overwritten
   * with undefined.
   */
  orgId?: string;
  runBy?: string;
};

/** The `nango-system` surface slice this client consumes. */
export type DrupalNangoSurfaceSlice = Pick<
  NangoSystemSurface,
  | "isNangoConfigured"
  | "ensureNangoConnectorIntegration"
  | "importNangoConnection"
  | "getNangoCredentials"
  | "deleteNangoConnection"
  | "removeNangoConnectionRecord"
  | "saveNangoConnectionRecord"
  | "providerConfigKeys"
>;

/** The host instance-connection-gate slice this client consumes (#975 W3 /
 * cinatra#1077). The gate decision, audit rows, actor construction and
 * identity-row storage stay HOST-SIDE (authz stays core); this client resolves
 * outcome records only. */
export type DrupalConnectionGateSlice = Pick<
  HostInstanceConnectionGateService,
  "enforceInstanceConnectionUse" | "resolveTrustedSessionBinding"
>;

/**
 * The injected capability resolvers. Every member is a LAZY thunk resolved at
 * call time (never at construction) so building the client is probe-safe and
 * activation order against the host boot wiring never matters. A missing
 * provider FAILS LOUD through the thunk (register.ts's hostService /
 * nangoSystem resolvers own the descriptive error).
 */
export type DrupalInstanceStoreDeps = {
  /** The host `connector-config` KV capability (read/write of the `drupal` row). */
  connectorConfig(): {
    read<T>(connectorId: string, fallback: T): T;
    write(connectorId: string, value: unknown): void;
  };
  /** The connector-authored `nango-system` surface. */
  nango(): DrupalNangoSurfaceSlice;
  /** The host `@cinatra-ai/host:instance-connection-gate` service. */
  connectionGate(): DrupalConnectionGateSlice;
  /** Swallowed-cleanup warning sink (ctx.logger.warn — #981 channel). Message
   * text keeps the exact former `[drupal-api]` label for log parity. */
  warn(message: string): void;
};

/** The relocated client surface (the drupal-api function set, 1:1). */
export type DrupalInstanceClient = {
  getDrupalAPISettings(): DrupalAPISettings;
  saveDrupalInstance(input: SaveDrupalInstanceInput): Promise<DrupalInstanceSettings>;
  persistLocalDevDrupalInstanceUnvalidated(input: {
    id?: string;
    name: string;
    siteUrl: string;
  }): Promise<DrupalInstanceSettings>;
  deleteDrupalInstance(id: string): Promise<void>;
  listDrupalInstances(): Promise<DrupalInstanceSettings[]>;
  getDrupalAPIStatus(): Promise<DrupalAPIStatus>;
};

const CONFIG_KEY = "drupal";

/**
 * Strip trailing slashes via a LINEAR char-index trim (the form core's module
 * mandated for new code — the anchored greedy `/\/+$/` it replaced is
 * polynomial-ReDoS, CodeQL `js/polynomial-redos`). Behavior-identical output.
 */
function trimTrailingSlashesLinear(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return input.slice(0, end);
}

function normalizeSiteUrl(url: string): string {
  return trimTrailingSlashesLinear(url.trim());
}

function extractApiKey(credentials: unknown): string | null {
  if (credentials && typeof credentials === "object" && "apiKey" in credentials) {
    const candidate = (credentials as { apiKey: unknown }).apiKey;
    return typeof candidate === "string" ? candidate : null;
  }
  if (typeof credentials === "string") return credentials;
  return null;
}

export function buildDrupalInstanceClient(deps: DrupalInstanceStoreDeps): DrupalInstanceClient {
  function readSettings(): DrupalAPISettings {
    return deps.connectorConfig().read<DrupalAPISettings>(CONFIG_KEY, { instances: [] });
  }

  function writeSettings(value: DrupalAPISettings): void {
    deps.connectorConfig().write(CONFIG_KEY, value);
  }

  function getDrupalAPISettings(): DrupalAPISettings {
    const settings = readSettings();
    return {
      instances: Array.isArray(settings.instances)
        ? settings.instances
            .map((instance) => ({
              id: String(instance.id ?? ""),
              name: String(instance.name ?? "").trim(),
              siteUrl: normalizeSiteUrl(String(instance.siteUrl ?? "")),
              nangoConnectionId: String(instance.nangoConnectionId ?? "").trim(),
              providerConfigKey:
                String(instance.providerConfigKey ?? "").trim() ||
                deps.nango().providerConfigKeys.drupal,
              lastValidatedAt:
                typeof instance.lastValidatedAt === "string" ? instance.lastValidatedAt : undefined,
              createdAt:
                typeof instance.createdAt === "string"
                  ? instance.createdAt
                  : new Date().toISOString(),
              updatedAt:
                typeof instance.updatedAt === "string"
                  ? instance.updatedAt
                  : new Date().toISOString(),
              // Optional multi-tenant install→org binding (cinatra#274).
              orgId:
                typeof instance.orgId === "string" ? instance.orgId.trim() || undefined : undefined,
              runBy:
                typeof instance.runBy === "string" ? instance.runBy.trim() || undefined : undefined,
            }))
            // Require `nangoConnectionId` so only Nango-backed instances are
            // returned. Rows without a Nango pointer cannot be used for
            // credential lookup.
            .filter(
              (instance) =>
                instance.id && instance.name && instance.siteUrl && instance.nangoConnectionId,
            )
        : [],
    } satisfies DrupalAPISettings;
  }

  /**
   * Capture the {orgId, runBy} install→org binding (cinatra#274) from the
   * current request's admin session through the host instance-connection-gate's
   * `resolveTrustedSessionBinding` — the only sanctioned FRESH-binding source
   * (validated session, never request input).
   *
   * - Returns `undefined` (no binding) unless BOTH the active organization id
   *   and the user id resolve — never half a binding (the host member returns
   *   null rather than half a binding; folded to undefined here to preserve the
   *   former in-repo return shape).
   * - NEVER throws or redirects on a session-less call path (local-dev /
   *   dev-auto-setup, or a request with no cookies): the host member is
   *   read-only and never throws, so the row keeps whatever binding it already
   *   had and the resolver falls back to single-tenant identity. It does not
   *   gate the save (the connector's `requireExtensionAction("manage")` already
   *   did). A MISSING gate capability, by contrast, fails loud through
   *   `deps.connectionGate()` — a host boot-wiring violation, never a silent
   *   fallback.
   */
  async function resolveActorBindingFromSession(): Promise<
    { orgId: string; runBy: string } | undefined
  > {
    return (await deps.connectionGate().resolveTrustedSessionBinding()) ?? undefined;
  }

  /**
   * Save flow:
   *   1. Validate name + URL. Allow blank `mcpApiKey` only when editing.
   *   2. Throw if Nango is not configured.
   *   3. When `mcpApiKey` provided: ensure integration → import (NO
   *      connectorKey, deferring local pointer write) → getNangoCredentials
   *      with forceRefresh:true equality check → persist instance row WITHOUT
   *      mcpApiKey → saveNangoConnectionRecord separately.
   *   4. Edit-without-key path skips Nango calls and just rewrites name/URL.
   */
  async function saveDrupalInstance(
    input: SaveDrupalInstanceInput,
  ): Promise<DrupalInstanceSettings> {
    const trimmedName = input.name.trim();
    const normalizedUrl = normalizeSiteUrl(input.siteUrl);
    const trimmedKey = (input.mcpApiKey ?? "").trim();
    if (!trimmedName) throw new Error("Instance name is required.");
    if (!normalizedUrl) throw new Error("Site URL is required.");

    const current = getDrupalAPISettings();
    const existing = input.id ? current.instances.find((i) => i.id === input.id) : null;

    const isNewInstance = !existing;
    if (isNewInstance && (!trimmedKey || trimmedKey.length < 8)) {
      throw new Error("MCP API key is required (min 8 chars).");
    }
    if (!isNewInstance && trimmedKey && trimmedKey.length < 8) {
      throw new Error("MCP API key must be at least 8 chars when rotating.");
    }

    if (!deps.nango().isNangoConfigured()) {
      throw new Error(
        "Nango is not configured. Configure it at /configuration/llm/nango before saving Drupal credentials.",
      );
    }

    const id = existing?.id ?? randomUUID();
    const providerConfigKey = deps.nango().providerConfigKeys.drupal;
    const connectionId = id; // per-instance UUID

    const now = new Date().toISOString();

    // Multi-tenant install→org binding (cinatra#274). Prefer an explicitly
    // supplied {orgId, runBy}; otherwise capture it from the configuring
    // admin's session via the host gate. Resolved BEFORE the Nango readback
    // below so the same binding both seeds the connection's identity row
    // (cinatra#967) and gates the readback as the configuring admin. A
    // resolved binding never overwrites an existing one with undefined
    // (edit-without-session preserves the prior binding); a brand-new row with
    // no session simply has no binding (resolver falls back to single-tenant).
    const sessionBinding =
      input.orgId?.trim() && input.runBy?.trim()
        ? { orgId: input.orgId.trim(), runBy: input.runBy.trim() }
        : await resolveActorBindingFromSession();

    // When a key is provided (new instance OR rotation), run the full
    // ensure → import → readback flow. Otherwise (edit without key),
    // skip Nango entirely — only name/URL are changing.
    if (trimmedKey) {
      await deps.nango().ensureNangoConnectorIntegration("drupal");
      await deps.nango().importNangoConnection({
        // NO connectorKey — defers saveNangoConnectionRecord.
        providerConfigKey,
        connectionId,
        credentials: { type: "API_KEY", apiKey: trimmedKey },
        metadata: { siteUrl: normalizedUrl },
      });

      // Instance-import seam (cinatra#967, W3 residue): seed the connection's
      // identity row NOW (idempotent), then gate + audit the immediate
      // readback verification through the W2 owner-aware resolver, with the
      // configuring admin (or an org-bound InternalWorker fallback) threaded
      // as the acting actor. The host member folds the identity outcome to
      // `{ gated }` — an instance whose identity cannot be resolved at all
      // falls back to the pre-#967 ungated readback (never a regression); a
      // use-gate DENY throws fail-closed and propagates. The `source` label is
      // kept EXACTLY as the core client emitted it (audit-row parity).
      await deps.connectionGate().enforceInstanceConnectionUse({
        connectorKey: "drupal",
        connectionId,
        binding: sessionBinding,
        source: "drupal-api",
      });

      const readback = await deps
        .nango()
        .getNangoCredentials(providerConfigKey, connectionId, { forceRefresh: true });
      const readbackKey = extractApiKey(readback);
      if (readbackKey !== trimmedKey) {
        throw new Error(
          "Nango credential verification failed: the readback value did not match the saved credential.",
        );
      }
    }

    const nextOrgId = sessionBinding?.orgId ?? existing?.orgId;
    const nextRunBy = sessionBinding?.runBy ?? existing?.runBy;

    const next: DrupalInstanceSettings = existing
      ? {
          ...existing,
          name: trimmedName,
          siteUrl: normalizedUrl,
          nangoConnectionId: connectionId,
          providerConfigKey,
          updatedAt: now,
          orgId: nextOrgId,
          runBy: nextRunBy,
        }
      : {
          id,
          name: trimmedName,
          siteUrl: normalizedUrl,
          nangoConnectionId: connectionId,
          providerConfigKey,
          createdAt: now,
          updatedAt: now,
          orgId: nextOrgId,
          runBy: nextRunBy,
        };

    const remaining = current.instances.filter((i) => i.id !== next.id);
    writeSettings({ instances: [next, ...remaining] });

    // Local Nango pointer write happens AFTER cinatra DB persist + readback —
    // this keeps the pointer-before-readback gap closed.
    if (trimmedKey) {
      // `{ multiple: true }` is REQUIRED here. This path calls
      // importNangoConnection WITHOUT connectorKey, which bypasses the
      // schema-driven multiple inference inside
      // importNangoConnection. saveNangoConnectionRecord defaults to
      // multiple:false, so without this flag saving/rotating ONE Drupal
      // instance would replace ALL saved Drupal pointer records with just the
      // latest — breaking the multi-instance design.
      await deps.nango().saveNangoConnectionRecord(
        "drupal",
        {
          connectionId,
          providerConfigKey,
          displayName: trimmedName,
          metadata: { siteUrl: normalizedUrl },
        },
        { multiple: true },
      );
    }

    return next;
  }

  /**
   * LOCAL-DEV-ONLY recovery persist for `dev-setup.ts` (via the host's
   * dev-gated `dev-auto-setup` shell).
   *
   * `saveDrupalInstance` THROWS when Nango is not configured (it requires a
   * `drush mcp-tools:remote-key-create` Bearer to import + readback-verify into
   * the Nango vault). The UAT / a fresh dev box can run with NO Nango (only
   * placeholder LLM creds), so the FIRST Drupal wire never lands a configured
   * instance row, which in turn blocks `dev-auto-setup` from pushing the
   * browser widget config (`cinatra.settings cinatra_url`/`api_key`/
   * `instance_id`).
   *
   * The browser→cinatra WIDGET direction (validated by `widget-stream-auth`
   * against `drupal_widget_auth.apiKey`) does NOT depend on the cinatra→Drupal
   * `mcp_tools_remote` Bearer being stored. So this helper lets `dev-setup.ts`
   * persist a COMPLETE local-dev instance row WITHOUT any Nango side effect,
   * then push the widget config. The MCP WRITE path stays unconfigured (writes
   * 401) until Nango is configured — at which point the next boot's reconcile /
   * local-dev transition mints + imports the remote-key Bearer.
   *
   * `lastValidatedAt` is intentionally left UNSET (the row was NOT
   * network/Nango validated — no false attribution). `nangoConnectionId` is set
   * to the per-instance id ONLY so `getDrupalAPISettings`' Nango-pointer filter
   * lists the row; no actual Nango connection exists yet (credential lookups
   * fail-to-resolve → 401 until the transition runs). There is deliberately NO
   * `saveNangoConnectionRecord` / `importNangoConnection` here — a Nango
   * pointer with no readback-verified Bearer would be a corrupt/dangling
   * pointer.
   *
   * HARD-GATED to localhost: this NON-VALIDATING exported persist refuses any
   * non-local site URL (and the capability member wrapping it in register.ts is
   * ADDITIONALLY refused outside development via the host runtime-mode
   * capability). It must never become a general production affordance.
   *
   * SECRET BOUNDARY: writes no credential (none is involved) and logs nothing.
   */
  async function persistLocalDevDrupalInstanceUnvalidated(input: {
    id?: string;
    name: string;
    siteUrl: string;
  }): Promise<DrupalInstanceSettings> {
    const siteUrl = trimTrailingSlashesLinear(input.siteUrl.trim());
    const host = (() => {
      try {
        // `new URL("http://[::1]:8082").hostname` returns "[::1]" (brackets
        // kept). Strip the brackets so the IPv6 loopback compares cleanly.
        const h = new URL(siteUrl).hostname.toLowerCase();
        return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
      } catch {
        return "";
      }
    })();
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
      throw new Error("Unvalidated Drupal instance persistence is local-dev only.");
    }

    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw new Error("Instance name is required.");
    }

    const current = getDrupalAPISettings();
    const existing = input.id
      ? current.instances.find((i) => i.id === input.id)
      : current.instances.find((i) => i.siteUrl === siteUrl);

    const now = new Date().toISOString();
    const id = input.id?.trim() || existing?.id || randomUUID();
    const next: DrupalInstanceSettings = {
      id,
      name: trimmedName,
      siteUrl,
      // Set ONLY so getDrupalAPISettings lists the row; no real Nango
      // connection exists yet — the local-dev transition imports a Bearer once
      // Nango is on.
      nangoConnectionId: id,
      providerConfigKey: existing?.providerConfigKey ?? deps.nango().providerConfigKeys.drupal,
      // lastValidatedAt intentionally omitted — this row was NOT validated.
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // Preserve any existing multi-tenant install→org binding (cinatra#274).
      // This local-dev persist has no session, so it never sets a new binding.
      orgId: existing?.orgId,
      runBy: existing?.runBy,
    };

    const remaining = current.instances.filter(
      (i) => i.id !== next.id && i.siteUrl !== next.siteUrl,
    );
    writeSettings({ instances: [next, ...remaining] });

    return next;
  }

  /**
   * Delete instance + clean up Nango pointer + best-effort remote connection
   * delete. Errors during Nango cleanup are swallowed with a warning (Nango may
   * be unreachable or the connection may already be gone).
   */
  async function deleteDrupalInstance(id: string): Promise<void> {
    const current = getDrupalAPISettings();
    const target = current.instances.find((i) => i.id === id);
    writeSettings({ instances: current.instances.filter((i) => i.id !== id) });
    if (!target) return;
    try {
      await deps.nango().removeNangoConnectionRecord("drupal", target.nangoConnectionId);
    } catch (err) {
      deps.warn(
        `[drupal-api] removeNangoConnectionRecord failed for ${target.id} (ignored): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (deps.nango().isNangoConfigured()) {
      try {
        await deps.nango().deleteNangoConnection(target.providerConfigKey, target.nangoConnectionId);
      } catch (err) {
        deps.warn(
          `[drupal-api] deleteNangoConnection failed for ${target.id} (ignored): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async function listDrupalInstances(): Promise<DrupalInstanceSettings[]> {
    return getDrupalAPISettings().instances.sort((l, r) => r.updatedAt.localeCompare(l.updatedAt));
  }

  async function getDrupalAPIStatus(): Promise<DrupalAPIStatus> {
    const instances = await listDrupalInstances();
    return {
      instanceCount: instances.length,
      instances: instances.map((i) => ({
        id: i.id,
        name: i.name,
        siteUrl: i.siteUrl,
        lastValidatedAt: i.lastValidatedAt,
      })),
    };
  }

  return {
    getDrupalAPISettings,
    saveDrupalInstance,
    persistLocalDevDrupalInstanceUnvalidated,
    deleteDrupalInstance,
    listDrupalInstances,
    getDrupalAPIStatus,
  };
}
