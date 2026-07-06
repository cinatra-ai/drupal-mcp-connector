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

import type { ExtensionHostContext, NangoSystemSurface } from "@cinatra-ai/sdk-extensions";
import { registerDrupalConnector, type DrupalConnectorDeps } from "./deps";

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
}
