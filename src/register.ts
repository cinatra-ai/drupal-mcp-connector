// The drupal connector's `register(ctx)` server entry.
//
// Transport-DI inversion (cinatra#151 Stage 3): the host no longer statically
// imports `registerDrupalConnector` — this entry binds the connector's host
// deps AT ACTIVATION by adapting the per-concern host services published in
// the capability registry (`@cinatra-ai/host:*` — mcp-pagination,
// content-editor-dispatch, drupal-mcp) plus the connector-authored
// `nango-system` surface. Every adapter member resolves its host service
// LAZILY at call time, so activation order against the host's boot imports
// never matters.
//
// Registration-only (no I/O) — safe under required-extension-activation's
// prod-boot arming, and probe-safe (the hot-update probe's `resolveProviders`
// reads stay live, so a probe-bound deps slot resolves identically to an
// activation-bound one). Imports stay LEAF-only (`./deps`): the package index
// re-exports React components that must stay OUT of the serverEntry graph.
//
// SDK imports here are TYPE-ONLY (host-peer value-import ban): the host
// services arrive as DATA through `ctx.capabilities`; the capability ids are
// inlined string literals; the NEW per-concern service shapes are local
// structural types so the connector compiles against ANY host SDK it can
// meet during skew.

import { randomUUID } from "node:crypto";

import type {
  ExtensionHostContext,
  HostDrupalMcpService,
  NangoSystemSurface,
  ObjectsProvider,
} from "@cinatra-ai/sdk-extensions";
import { registerDrupalConnector, type DrupalConnectorDeps } from "./deps";
import {
  buildDrupalInstanceClient,
  type DrupalConnectionGateSlice,
} from "./lib/drupal-instances";
import {
  buildDrupalPointerActor,
  writeDrupalNodePointerWith,
  type DrupalNodePointerState,
} from "./integration/pointer-writer-core";

const PACKAGE_NAME = "@cinatra-ai/drupal-mcp-connector";

// Local STRUCTURAL shapes of the per-concern host services this connector
// adapts into its deps slot.
type HostMcpPaginationShape = {
  decodeCursor: DrupalConnectorDeps["decodeCursor"];
  buildListPage: DrupalConnectorDeps["buildListPage"];
};
type HostContentEditorDispatchShape = {
  dispatch: DrupalConnectorDeps["dispatchContentEditor"];
};
type HostDrupalMcpShape = {
  listInstances: DrupalConnectorDeps["listMcpInstances"];
  // ACTOR-SCOPED instance lister. OPTIONAL on the host service shape so this
  // connector compiles + activates against BOTH a pre-cutover host (member absent
  // → external-MCP toolbox fails closed: no tools) and a post-cutover host that
  // publishes the trusted-actor-scoped impl. The host
  // resolves the trusted actor from the MCP request frame (NEVER connector
  // input), returns ONLY the actor's org-entitled instances, and returns []
  // fail-closed when no actor resolves.
  listAuthorizedInstances?: NonNullable<DrupalConnectorDeps["listAuthorizedMcpInstances"]>;
  probe: DrupalConnectorDeps["probeMcp"];
  resolveServerUrl: DrupalConnectorDeps["resolveMcpServerUrl"];
  isPrivateUrl: DrupalConnectorDeps["isPrivateUrl"];
  // Instance-admin surface (cinatra#172 Stage H2). Host-side member names
  // (the SDK contract's) — the deps members keep connector-local names.
  getAPIStatus: DrupalConnectorDeps["getApiStatus"];
  saveInstance: DrupalConnectorDeps["saveInstance"];
  deleteInstance: DrupalConnectorDeps["deleteInstance"];
  getInstanceStatuses: DrupalConnectorDeps["listInstanceStatuses"];
};
// cinatra#409 — per-user / per-connector-instance write-authority host service
// (`HostInstanceWriteAuthorityService`, capability id below). The host binds an
// impl that derives the trusted actor from the active MCP request frame
// (mcpRequestContextStorage), DENIES fail-closed when no userId+orgId resolve,
// then enforces (1) PER-INSTANCE org-binding == the trusted actor's org (so a
// forged/cross-org instanceId is denied) and (2) the connector-package
// requireConnectorAuthority policy. `selectForConnector(kind)` maps the
// connector KIND to BOTH the package id and the instance reader HOST-SIDE — the
// connector names only its OWN static kind ("drupal"), never a package id or
// another caller-chosen selector. `requireWrite` resolves void on allow / throws
// on deny. The connector forwards only instanceId+primitiveName; identity is
// NEVER connector-supplied.
type HostInstanceWriteAuthorityShape = {
  selectForConnector(kind: string): {
    requireWrite: (input: { instanceId: string; primitiveName: string; sourceType?: string }) => Promise<void>;
  };
};

/** Lazy per-concern host-service resolution (fail-loud on a missing service —
 * the host boot wiring publishes these before any connector call runs). */
function hostService<T>(ctx: ExtensionHostContext, capability: string): T {
  const provider = ctx.capabilities.resolveProviders(capability)[0];
  if (!provider) {
    throw new Error(
      `${PACKAGE_NAME}: host service "${capability}" is not registered — ` +
        `the host boot wiring (register-host-connector-services) must run before connector calls.`,
    );
  }
  return provider.impl as T;
}

/** The connector-authored nango-system surface (registered by the nango
 * gateway's own register(ctx) — a systemExtension, required at boot). */
function nangoSystem(ctx: ExtensionHostContext): NangoSystemSurface {
  const provider = ctx.capabilities.resolveProviders("nango-system")[0];
  const surface = provider?.impl as NangoSystemSurface | undefined;
  if (!surface || typeof surface.isNangoConfigured !== "function") {
    throw new Error(
      `${PACKAGE_NAME}: the "nango-system" capability surface is not registered — ` +
        `resolve at call time (post-activation), never at module eval.`,
    );
  }
  return surface;
}

/** Build the host-bound deps from the per-concern host services. Every member
 * resolves LAZILY at call time — constructing this object does no I/O and no
 * resolution (probe-safe). */
function buildHostBoundDeps(ctx: ExtensionHostContext): DrupalConnectorDeps {
  const pagination = () => hostService<HostMcpPaginationShape>(ctx, "@cinatra-ai/host:mcp-pagination");
  const contentEditor = () =>
    hostService<HostContentEditorDispatchShape>(ctx, "@cinatra-ai/host:content-editor-dispatch");
  const drupalMcp = () => hostService<HostDrupalMcpShape>(ctx, "@cinatra-ai/host:drupal-mcp");
  // cinatra#409 — resolved lazily at call time; fail-loud if the host did not
  // publish it (an old host) so the writer denies rather than writes unguarded.
  const writeAuthority = () =>
    hostService<HostInstanceWriteAuthorityShape>(ctx, "@cinatra-ai/host:instance-write-authority");
  const nango = () => nangoSystem(ctx);
  return {
    decodeCursor: (cursor) => pagination().decodeCursor(cursor),
    buildListPage: <T,>(items: T[], total: number, offset: number, limit: number) =>
      pagination().buildListPage(items, total, offset, limit),
    dispatchContentEditor: (input) => contentEditor().dispatch(input),
    buildNangoBearerHeader: (input) => nango().buildBearerAuthHeaderFromNango(input),
    listMcpInstances: () => drupalMcp().listInstances(),
    // Actor-scoped instance lister for the
    // external-MCP toolbox-injection path. ALWAYS bound to a LAZY function (no
    // host resolution at construction — preserves the probe-safe no-I/O
    // invariant); at CALL time it resolves the host service and forwards to
    // `listAuthorizedInstances` IF the host publishes it (post-#321 host),
    // otherwise FAILS CLOSED by returning [] (pre-#321 host) — the toolbox then
    // injects no tools and NEVER falls back to the unscoped `listInstances`. The
    // host impl derives the trusted actor from the MCP request frame and applies
    // the same org/entitlement gate as the write-authority service.
    listAuthorizedMcpInstances: async () => {
      const svc = drupalMcp();
      if (typeof svc.listAuthorizedInstances !== "function") return [];
      return svc.listAuthorizedInstances();
    },
    probeMcp: (siteUrl, authHeader) => drupalMcp().probe(siteUrl, authHeader),
    resolveMcpServerUrl: (siteUrl) => drupalMcp().resolveServerUrl(siteUrl),
    isPrivateUrl: (url) => drupalMcp().isPrivateUrl(url),
    isNangoConfigured: () => nango().isNangoConfigured(),
    // Instance-admin surface (cinatra#172 Stage H2): the writers stay behind
    // the settings page's manage-gated "use server" actions — the adapter
    // adds no gating of its own (the host service's TRUST note documents the
    // shared in-process capability id).
    getApiStatus: () => drupalMcp().getAPIStatus(),
    saveInstance: (input) => drupalMcp().saveInstance(input),
    deleteInstance: (id) => drupalMcp().deleteInstance(id),
    listInstanceStatuses: () => drupalMcp().getInstanceStatuses(),
    // cinatra#409 — per-user write authorization. Binds to the connector's OWN
    // static KIND ("drupal") — the host maps it to BOTH the package id and the
    // instance reader; the connector forwards only instanceId+primitiveName, and
    // the host impl derives the trusted actor from the MCP request frame and
    // throws on deny / null actor (fail-closed). If the host service is absent
    // (old host), hostService() throws → here the throw surfaces as a REJECTED
    // promise (async member) so the awaiting writer denies (never writes
    // unguarded), the same as a real deny.
    requireInstanceWriteAuthority: async (input) =>
      writeAuthority().selectForConnector("drupal").requireWrite(input),
  };
}

// The generic host connector-config KV service
// (`@cinatra-ai/host:connector-config`) — the per-connector key/value store the
// host publishes. The widget-auth store (below) persists through it.
type HostConnectorConfigShape = {
  read<T>(connectorId: string, fallback: T): T;
  write(connectorId: string, value: unknown): void;
};

// --- widget auth-config store (cinatra#975 Wave 2 — vendor-publish-direction
// inversion, epic #978) -------------------------------------------------------
// This connector now OWNS the widget-auth store: it INVERTED out of core
// (`@/lib/drupal-widget-auth`) and is registered as the
// `@cinatra-ai/host:drupal-widget-auth` capability (in register() below). The
// store persists the UUID-pair widget api key under
// `connector_config:drupal_widget_auth` THROUGH the host connector-config
// capability. read/generate are SYNC — behavior-identical to the former core
// store. The request-time origin/token/CORS validation is unchanged: it lives in
// the host's generic widget-stream auth (via the cinatra.widgetStream.auth
// manifest entry), NOT here; only the AUTH-CONFIG storage + minting moved.
const WIDGET_AUTH_CONFIG_KEY = "drupal_widget_auth";

type DrupalWidgetAuthConfig = {
  apiKey: string;
  generatedAt: string;
};

type DrupalWidgetAuthProvider = {
  read(): DrupalWidgetAuthConfig | null;
  /** WRITER — mint + persist a fresh widget api key (invalidates the old). */
  generate(): DrupalWidgetAuthConfig;
};

/** Build the widget-auth store impl this connector registers. Every member
 * resolves the host connector-config capability LAZILY at call time (no
 * resolution at construction — probe-safe), then reads/writes the single config
 * row. Fail-loud: a host that never published connector-config throws through
 * hostService(). */
function buildWidgetAuthProvider(ctx: ExtensionHostContext): DrupalWidgetAuthProvider {
  const connectorConfig = () =>
    hostService<HostConnectorConfigShape>(ctx, "@cinatra-ai/host:connector-config");
  return {
    read: () => connectorConfig().read<DrupalWidgetAuthConfig | null>(WIDGET_AUTH_CONFIG_KEY, null),
    generate: () => {
      const config: DrupalWidgetAuthConfig = {
        apiKey: `${randomUUID()}-${randomUUID()}`,
        generatedAt: new Date().toISOString(),
      };
      connectorConfig().write(WIDGET_AUTH_CONFIG_KEY, config);
      return config;
    },
  };
}

// --- Drupal instance-settings client (cinatra#975 Wave 3 — vendor-publish-
// direction inversion, epic #978) ---------------------------------------------
// This connector now OWNS the instance-settings client: it INVERTED out of core
// (`@/lib/drupal-api`, ~460 LOC) into `./lib/drupal-instances` and is registered
// below as a provider under the SAME `@cinatra-ai/host:drupal-mcp` capability id
// the host publishes (provider-flip — NO sdk-extensions contract change).
// Providers coexist keyed by packageName: the host boot wiring
// (register-host-connector-services) registers its full-service provider BEFORE
// activation, so every existing `[0]` resolver keeps resolving the host impl
// unchanged until the single core-eviction follow-up PR re-points core's
// registration at THIS provider (resolved by packageName from the generated
// manifest — the W2 widget-auth anti-spoof pattern).
//
// The provider carries ONLY the relocated drupal-api member set. Explicit
// NON-members (they stay host-side this slice): probe / resolveServerUrl /
// isPrivateUrl / getInstanceStatuses (the `@/lib/drupal-mcp-connection` +
// url-policy surface) and listAuthorizedInstances (the actor-gated
// instance-list authority — authz stays core, the #975 pin), plus
// devProbeWithBearer / devInvalidateProbeCache (the host probe cache).

/** The host runtime-mode service (`@cinatra-ai/host:runtime-mode`). */
type HostRuntimeModeShape = { isDevelopment(): boolean };

type DrupalInstanceAdminProvider = Pick<
  HostDrupalMcpService,
  "listInstances" | "getAPIStatus" | "saveInstance" | "deleteInstance" | "devPersistLocalInstanceUnvalidated"
>;

/** Build the connector-owned drupal-mcp instance-admin provider. Every member
 * resolves its host capabilities LAZILY at call time (no resolution at
 * construction — probe-safe); a missing capability fails loud through
 * hostService()/nangoSystem(). */
function buildDrupalInstanceAdminProvider(ctx: ExtensionHostContext): DrupalInstanceAdminProvider {
  const client = buildDrupalInstanceClient({
    connectorConfig: () =>
      hostService<HostConnectorConfigShape>(ctx, "@cinatra-ai/host:connector-config"),
    nango: () => nangoSystem(ctx),
    connectionGate: () =>
      hostService<DrupalConnectionGateSlice>(ctx, "@cinatra-ai/host:instance-connection-gate"),
    // Swallowed-cleanup warnings route through the ambient logger port (#981);
    // the message text keeps the exact former `[drupal-api]` label.
    warn: (message) => ctx.logger.warn(message),
  });
  return {
    listInstances: () => client.getDrupalAPISettings().instances,
    getAPIStatus: () => client.getDrupalAPIStatus(),
    saveInstance: (input) => client.saveDrupalInstance(input),
    deleteInstance: (id) => client.deleteDrupalInstance(id),
    // Dev-boot provisioning member (cinatra#976, epic #978 W-D). Resolved ONLY
    // by this connector's own `dev-setup.ts` hook via the strictly dev-gated
    // `dev-auto-setup` shell — defense-in-depth refused outside development
    // (the same guard + message the host registration carried; the persist
    // helper itself ALSO enforces loopback-only).
    devPersistLocalInstanceUnvalidated: async (input) => {
      if (!hostService<HostRuntimeModeShape>(ctx, "@cinatra-ai/host:runtime-mode").isDevelopment()) {
        throw new Error(
          "drupal-mcp.devPersistLocalInstanceUnvalidated is a dev-only devSetup provisioning member; refused outside development.",
        );
      }
      const persisted = await client.persistLocalDevDrupalInstanceUnvalidated(input);
      return { id: persisted.id };
    },
  };
}

// --- Drupal external-pointer registration (cinatra#1465, epic #1448) ---------
// The connector's half of the `drupal:node` pointer lifecycle: it WRITES pointer
// rows for the HOST-registered `@cinatra-ai/drupal:node` type
// (packages/objects/.../register-types.ts, #1815) through the host objects
// surface. The TRIGGERS — the node-published webhook sync and the periodic
// linked→stale→dangling verification sweep — resolve the `drupal-pointer-writer`
// capability and supply the probe-derived reference state + the org/user the
// pointer actor is minted from (the twenty-pointer-writer precedent: the
// connector ships the writer, the host wires the caller). Resolving the objects
// provider does NO I/O at registration; the impl fails loud at WRITE time if the
// host never wired the objects surface (an old host), so a pointer is never
// written unguarded.

/** The host objects-integration service shape (structural mirror — the connector
 * compiles against any host SDK that meets it; the host binds the real
 * `objectTypeRegistry` / `objects_save` surface at boot). */
type HostObjectsIntegrationShape = { getObjectsProvider(): ObjectsProvider | null };

/** Resolve the host objects provider, or null when the host never published the
 * objects-integration service. */
function hostObjectsProvider(ctx: ExtensionHostContext): ObjectsProvider | null {
  const provider = ctx.capabilities.resolveProviders("@cinatra-ai/host:objects-integration")[0];
  return (provider?.impl as HostObjectsIntegrationShape | undefined)?.getObjectsProvider() ?? null;
}

/** The `drupal-pointer-writer` capability payload: a node identity + its
 * probe-derived reference state + the org/user the pointer actor is minted from. */
export type DrupalPointerWriteRequest = {
  /** Connected-site (instance) id — the Drupal node id is site-scoped. */
  instanceId: string;
  /** Drupal node id (unique within the site). */
  nodeId: number | string;
  /** Absolute http(s) URL that opens the node in Drupal. */
  url: string;
  /** Probe-derived reference state (defaults `linked`). */
  state?: DrupalNodePointerState;
  title?: string;
  excerpt?: string;
  /** Upstream version (Drupal node `changed`) for the next probe's diff. */
  remoteVersion?: string;
  /** ISO timestamp of the sync that materialized/verified the pointer. */
  verifiedAt?: string;
  /** The org the pointer row is scoped to (REQUIRED — objects_save rejects a null org). */
  orgId: string;
  /** The user, when the trigger is user-attributed. */
  userId?: string | null;
};

export function register(ctx: ExtensionHostContext): void {
  // Transport-DI inversion: bind the host deps slot. Always-bind (the
  // bind-if-absent skew guard was swept once every host this connector can
  // meet is post-cutover): re-activation — incl. a hot-update digest swap —
  // re-binds fresh lazy resolvers, so a stale deps object can never outlive
  // its digest.
  registerDrupalConnector(buildHostBoundDeps(ctx));

  // cinatra#975 Wave 2 — register the connector-owned widget-auth store as the
  // `@cinatra-ai/host:drupal-widget-auth` capability. The publish direction
  // inverted: the host no longer implements/publishes it; this connector's own
  // dev-setup hook resolves it lazily from the registry. Building the impl does
  // no host-service resolution (probe-safe) — read/generate resolve
  // connector-config at call time.
  ctx.capabilities.registerProvider("@cinatra-ai/host:drupal-widget-auth", {
    packageName: PACKAGE_NAME,
    impl: buildWidgetAuthProvider(ctx),
  });

  // cinatra#975 Wave 3 (drupal slice) — register the connector-owned Drupal
  // instance-settings client as a provider under the SAME
  // `@cinatra-ai/host:drupal-mcp` capability id (see the module note above
  // buildDrupalInstanceAdminProvider: coexistence keyed by packageName; the
  // core-eviction follow-up re-points core's registration at this provider).
  // Building the impl does no host-service resolution (probe-safe) — every
  // member resolves connector-config / nango-system / instance-connection-gate /
  // runtime-mode at call time.
  ctx.capabilities.registerProvider("@cinatra-ai/host:drupal-mcp", {
    packageName: PACKAGE_NAME,
    impl: buildDrupalInstanceAdminProvider(ctx),
  });

  // cinatra#1465 — the connector-owned `drupal:node` pointer writer. The host
  // sync/webhook trigger resolves this capability and supplies the node identity
  // + probe-derived reference state + org/user; the impl mints the pointer actor
  // and upserts the pointer row (idempotent by instance + node id) through the
  // host objects surface. Building the impl does NO host-service resolution and
  // NO I/O (probe-safe) — the objects provider resolves lazily at write time.
  ctx.capabilities.registerProvider("drupal-pointer-writer", {
    packageName: PACKAGE_NAME,
    impl: {
      writePointer: async (request: DrupalPointerWriteRequest) => {
        const provider = hostObjectsProvider(ctx);
        if (!provider) {
          throw new Error(`${PACKAGE_NAME}: host objects surface is not wired`);
        }
        const { orgId, userId, ...pointer } = request;
        return writeDrupalNodePointerWith(
          provider,
          pointer,
          buildDrupalPointerActor({ orgId, userId: userId ?? null }),
        );
      },
    },
  });
}
