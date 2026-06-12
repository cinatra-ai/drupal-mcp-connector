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
  const nango = () => nangoSystem(ctx);
  return {
    decodeCursor: (cursor) => pagination().decodeCursor(cursor),
    buildListPage: <T,>(items: T[], total: number, offset: number, limit: number) =>
      pagination().buildListPage(items, total, offset, limit),
    dispatchContentEditor: (input) => contentEditor().dispatch(input),
    buildNangoBearerHeader: (input) => nango().buildBearerAuthHeaderFromNango(input),
    listMcpInstances: () => drupalMcp().listInstances(),
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
  };
}

export function register(ctx: ExtensionHostContext): void {
  // Transport-DI inversion: bind the host deps slot. Always-bind (the
  // bind-if-absent skew guard was swept once every host this connector can
  // meet is post-cutover): re-activation — incl. a hot-update digest swap —
  // re-binds fresh lazy resolvers, so a stale deps object can never outlive
  // its digest.
  registerDrupalConnector(buildHostBoundDeps(ctx));
}
