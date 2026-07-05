// Host DI singleton for Drupal connector runtime dependencies.
//
// The connector carries NO non-SDK `@cinatra-ai/*` code dependency: every
// host-shared surface it needs at runtime is delivered here and the host binds
// concrete impls at boot via `registerDrupalConnector(deps)`. Runtime callers
// resolve them via `getDrupalDeps()`. Surfaces:
//   - pagination       — `@/lib/mcp-pagination` (decodeCursor / buildListPage).
//   - dispatchContentEditor — A2A blocking dispatch to the
//                         wayflow-drupal-content-editor agent. The host helper
//                         mints the A2A bearer (buildA2aBearerToken("openai")),
//                         opens the external A2A client, sends the task, walks
//                         task.history, and returns the agent's reply TEXT. The
//                         connector keeps only the stripCodeFences + JSON.parse
//                         of that text (so the @cinatra-ai/a2a + @cinatra-ai/llm
//                         runtime edges live host-side, not here).
//   - buildNangoBearerHeader — Nango-vault bearer header for the Drupal MCP
//                         HTTP client (host-sourced from the nango-connector
//                         extension) so this connector carries no
//                         `@cinatra-ai/nango-connector` code import.
//   - instance-admin   — `@/lib/drupal-api` save/delete/status + the
//                         per-instance MCP reachability statuses
//                         (`@/lib/drupal-mcp-connection`) consumed by the
//                         settings page + MCP handlers (cinatra#172 Stage H2;
//                         both host modules stay host-side).
//
// The deps slot is anchored on `globalThis` via a namespaced+versioned Symbol so
// the boot-time registration and the runtime callers — which live in
// SEPARATELY-COMPILED Next.js bundles (the /connectors page, the connector setup
// page, the MCP dispatch route) that do NOT import the registrar — resolve the
// SAME slot. A plain module-local binding would leave those bundles' instance
// unregistered → getDrupalDeps() would throw. (Same reason as the SDK
// action-guard + apollo/gemini deps + email-connector registry.)

type ListPage<T> = { items: T[]; total: number; nextCursor?: string };

/**
 * A2A blocking-dispatch surface. The host helper builds the A2A bearer
 * (`buildA2aBearerToken("openai")`), opens the external A2A client, sends a
 * single text-mode task carrying `payload`, walks `task.history` for the last
 * agent/assistant message, and resolves with that message's concatenated text.
 * The connector does the `stripCodeFences` + `JSON.parse` itself.
 */
export type DrupalDispatchContentEditorInput = {
  /** Resolved A2A endpoint for the wayflow-drupal-content-editor agent. */
  agentUrl: string;
  /**
   * Opaque JSON-serializable payload forwarded as the A2A message text. The
   * connector passes the validated `input` OBJECT; the host serializes it when
   * it builds the A2A task text. SAME shape as the WordPress connector's seam
   * (#72 content-editor payload-contract parity) so the host binds ONE shared
   * helper for both.
   */
  payload: unknown;
  /** Blocking budget in ms (the connector passes 300_000 to align with /chat). */
  timeoutMs: number;
  /**
   * npm package name of the content-editor agent (cinatra#246). The host uses
   * it to resolve the agent template and pre-create a real `agent_run` row
   * bound to the deployment's identity, so the downstream `/api/mcp` CMS write
   * is authorized through the production agent-run OBO path (not the dev-admin
   * bypass). Always `@cinatra-ai/drupal-agent` for this connector.
   */
  packageName: string;
};

/**
 * Nango-vault bearer header builder. Mirrors
 * `@cinatra-ai/nango-connector`'s `buildBearerAuthHeaderFromNango`: returns the
 * `{ Authorization }` header or `null` when Nango is unconfigured / the
 * credential is missing. NEVER include the token in the `label` — it is
 * warn-only logging text.
 */
export type DrupalNangoBearerHeaderInput = {
  providerConfigKey: string;
  connectionId: string;
  label: string;
};

/**
 * The instance fields the external-MCP toolbox needs (structural subset of the
 * host's `DrupalInstanceSettings` — `@/lib/drupal-api` stays host-side).
 */
export type DrupalMcpInstance = {
  id: string;
  name: string;
  siteUrl: string;
  /** Nango connectionId under the cinatra-drupal integration. */
  nangoConnectionId: string;
  /** Pinned providerConfigKey for forward compatibility. */
  providerConfigKey: string;
  /** Row metadata (host rows always carry these; optional for skew). */
  lastValidatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Public (redacted) projection of a Drupal instance for READ/LIST primitives.
 * NEVER carries the Nango credential binding (`nangoConnectionId` /
 * `providerConfigKey`) — those name the vault slot a caller could use to reach
 * the site's stored credential, so read-capable callers (incl. LLM tool paths)
 * must never receive them. The `drupal_instances_list` read handler returns
 * this shape; write/dispatch primitives keep resolving the FULL
 * `DrupalMcpInstance` row host-side (credentials are read at call time via
 * callDrupalMcp / the external-MCP toolbox). Mirrors the WordPress sibling's
 * `WordPressMcpPublicInstance`.
 */
export type DrupalMcpPublicInstance = {
  id: string;
  name: string;
  siteUrl: string;
  lastValidatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

/** Probe verdict for a Drupal `drupal/mcp_tools` endpoint (host-bound probe). */
export type DrupalMcpProbeStatus = "registered" | "not_installed" | "auth_error" | "unreachable";

/** Aggregate status (the `drupal_status` primitive read; host-bound). */
export type DrupalApiStatus = {
  instanceCount: number;
  instances: Array<{ id: string; name: string; siteUrl: string; lastValidatedAt?: string }>;
};

/** Save-instance input envelope (structural mirror of the host's
 * `SaveDrupalInstanceInput` — key REQUIRED for new instances, optional on
 * edit/rotation; the host validates). */
export type DrupalSaveInstanceInput = {
  id?: string;
  name: string;
  siteUrl: string;
  mcpApiKey?: string;
};

/** Per-instance MCP reachability status (host probe + Nango bearer). */
export type DrupalMcpInstanceStatus = {
  id: string;
  name: string;
  siteUrl: string;
  status: DrupalMcpProbeStatus;
  isPrivate: boolean;
};

/**
 * Per-user / per-connector-instance write-authority gate input (cinatra#409).
 *
 * The handler passes ONLY the non-identity coordinates of the write: which
 * `instanceId` the write targets and which `primitiveName` is being invoked.
 * The CALLER IDENTITY IS NEVER PASSED HERE — the host implementation derives the
 * trusted actor (`userId`/subject = the carrier run's `runBy`, `orgId`,
 * `orgRole`, `platformRole`, `sourceType`) host-side from the active MCP request
 * frame (`mcpRequestContextStorage` via `extension-host-actor.ts`), so a
 * connector can never assert or forge identity through tool input.
 */
export type RequireInstanceWriteAuthorityInput = {
  /** The instance the write targets (the tool INPUT argument naming WHICH
   * instance). The host checks the trusted user holds the required `use` right
   * ON THIS instance via `requireConnectorAuthority(<pkg>, actor, {mode:"use",
   * instanceId})`; `enforceConnectorPolicy` keys on `actor.organizationId`, so a
   * different-org instance denies (no grant for that org's verified actor). */
  instanceId: string;
  /** The write primitive name, for the audit row only (never an authz input). */
  primitiveName: string;
};

export interface DrupalConnectorDeps {
  decodeCursor: (cursor?: string) => number;
  buildListPage: <T>(items: T[], total: number, offset: number, limit: number) => ListPage<T>;
  /** A2A blocking dispatch — returns the agent's reply text (host-bound). */
  dispatchContentEditor: (input: DrupalDispatchContentEditorInput) => Promise<string>;
  /** Nango-vault bearer header for the Drupal MCP HTTP client (host-bound). */
  buildNangoBearerHeader: (
    input: DrupalNangoBearerHeaderInput,
  ) => Promise<{ Authorization: string } | null>;
  // ---- external-MCP toolbox surfaces (host-bound; consumed by src/mcp/toolbox.ts) ----
  /**
   * ALL configured Drupal instances (host `@/lib/drupal-api` settings) — the
   * GLOBAL, UNSCOPED list. This is NOT actor-aware: it carries every tenant's
   * instance rows. It is safe ONLY for the in-process MCP primitive handlers,
   * where the per-user / per-instance authorization gate
   * (`requireInstanceWriteAuthority`) runs host-side on the trusted MCP request
   * frame BEFORE any write. The external-MCP toolbox-injection path
   * (`src/mcp/toolbox.ts`) MUST NOT use this — it would inject another tenant's
   * credential-bearing MCP server into an LLM call with no actor check
   * (confused-deputy authz bypass). The toolbox uses `listAuthorizedMcpInstances` instead.
   */
  listMcpInstances: () => DrupalMcpInstance[];
  /**
   * ACTOR-SCOPED instance list for the external-MCP toolbox-injection path.
   * Returns ONLY the Drupal instances the TRUSTED requesting actor's org is
   * entitled to `use`.
   *
   * AUTHORIZATION-AT-THE-CREDENTIAL-BOUNDARY: the toolbox builds a per-instance
   * Nango bearer header (another tenant's credential) and injects each reachable
   * instance as an always-available external MCP server for an LLM call. The
   * actor filter MUST therefore run BEFORE any bearer header is built, so no
   * credential for a non-entitled tenant is ever resolved or exposed. Approval
   * is NOT authorization — this enforces org OWNERSHIP at the list/read boundary,
   * not merely at exposure.
   *
   * IDENTITY IS HOST-DERIVED ONLY: like `requireInstanceWriteAuthority`, the host
   * implementation resolves the trusted actor (`userId`/`orgId`/`platformRole`)
   * from the active MCP/llm request frame (`resolveExtensionActorContext()` —
   * NEVER from connector input or the SDK `request.actor` field), then returns
   * the subset of `listMcpInstances()` whose persisted org binding (cinatra#274)
   * matches the actor's org AND for which the actor holds the connector `use`
   * right (`requireConnectorAuthority(..., {mode:"use", instanceId})`).
   *
   * FAIL-CLOSED CONTRACT: when NO trusted actor resolves (null `userId`/`orgId` —
   * e.g. an unauthenticated/legacy call frame), the host impl returns `[]` (NO
   * tools injected), never the global list. The toolbox additionally treats this
   * dep being UNBOUND or not-a-function (old/skewed host) as deny — it injects
   * nothing rather than fall back to the unscoped `listMcpInstances`.
   */
  listAuthorizedMcpInstances?: () => Promise<DrupalMcpInstance[]>;
  /** Cached reachability probe of an instance's MCP endpoint (host-bound). */
  probeMcp: (siteUrl: string, authHeader: string) => Promise<DrupalMcpProbeStatus>;
  /** Canonical MCP endpoint URL for a site (host owns the route constant). */
  resolveMcpServerUrl: (siteUrl: string) => string;
  /** True for private/local URLs external LLM providers cannot reach. */
  isPrivateUrl: (url: string) => boolean;
  /** True when the workspace has Nango configured (credentials present). */
  isNangoConfigured: () => boolean;
  // ---- instance-admin surfaces (cinatra#172 Stage H2; the settings page +
  //      mcp handlers consume these — `@/lib/drupal-api` and
  //      `@/lib/drupal-mcp-connection` stay host-side) ----
  /** Aggregate status for the `drupal_status` primitive (host-bound). */
  getApiStatus: () => Promise<DrupalApiStatus>;
  /** WRITER — persist an instance row (Nango import + readback host-side).
   * Only ever called behind the settings page's manage-gated "use server"
   * action — the same `requireExtensionAction` posture as the static import
   * it replaces. */
  saveInstance: (input: DrupalSaveInstanceInput) => Promise<DrupalMcpInstance>;
  /** WRITER — hard-delete an instance row (best-effort Nango cleanup
   * host-side). Manage-gated at the calling action, as above. */
  deleteInstance: (id: string) => Promise<void>;
  /** Per-instance MCP reachability statuses (host probe + Nango bearer). */
  listInstanceStatuses: () => Promise<DrupalMcpInstanceStatus[]>;
  // ---- per-user write-authority gate (cinatra#409; host-bound) ----
  /**
   * WRITE AUTHZ — per-user / per-connector-instance entitlement gate. EVERY
   * Drupal write primitive (`drupal_node_update`,
   * `drupal_node_create_draft_revision`, `drupal_node_publish`) MUST `await`
   * this BEFORE dispatching the write to `callDrupalMcp`. It THROWS on deny;
   * resolving without throwing is the only "allow".
   *
   * Host-side the impl: (a) resolves the trusted actor from the active MCP
   * request frame (`resolveExtensionActorContext()` / `resolveExtensionActorSummary()`
   * — NEVER from connector tool input); (b) DENIES (throws) if it cannot resolve
   * a `userId`+`orgId` (null actor → fail-closed, no synthetic/anonymous write);
   * (c) calls `requireConnectorAuthority("@cinatra-ai/drupal-mcp-connector",
   * actor, {mode:"use", instanceId})` and throws on deny; (d) for the
   * `public_site_widget` source the platform-admin bypass is NOT honored
   * (already true post-#408 because `resolveAgentRunMcpActor` suppresses
   * platform_admin on that path); (e) emits the per-decision audit row.
   *
   * FAIL-CLOSED CONTRACT: this dep is the handler's only authorization. If it is
   * UNBOUND on an old host (`getDrupalDeps().requireInstanceWriteAuthority`
   * absent) the writer MUST throw rather than write — see the handler guards. It
   * is declared REQUIRED here; the handler additionally guards `typeof !==
   * "function"` defensively so a skewed/partial binding still fails closed.
   */
  requireInstanceWriteAuthority: (
    input: RequireInstanceWriteAuthorityInput,
  ) => Promise<void>;
}

const DRUPAL_DEPS_KEY = Symbol.for("@cinatra-ai/drupal-mcp-connector:host-deps/v1");
type DepsHolder = { [k: symbol]: DrupalConnectorDeps | null | undefined };
const _holder = globalThis as unknown as DepsHolder;

export function registerDrupalConnector(deps: DrupalConnectorDeps): void {
  _holder[DRUPAL_DEPS_KEY] = deps;
}


export function getDrupalDeps(): DrupalConnectorDeps {
  const deps = _holder[DRUPAL_DEPS_KEY];
  if (!deps) {
    throw new Error(
      "@cinatra-ai/drupal-mcp-connector: host runtime deps not registered. " +
        "Call registerDrupalConnector(deps) at boot.",
    );
  }
  return deps;
}

/** @internal test-only. */
export function _resetDrupalDepsForTests(): void {
  _holder[DRUPAL_DEPS_KEY] = null;
}

/**
 * Configured instances, most-recently-updated first — the host's
 * `listDrupalInstances()` ordering, replicated connector-side over the
 * `listMcpInstances` rows (shared by the settings page and the MCP handlers).
 */
export function listMcpInstancesSorted(): DrupalMcpInstance[] {
  return [...getDrupalDeps().listMcpInstances()].sort((l, r) =>
    (r.updatedAt ?? "").localeCompare(l.updatedAt ?? ""),
  );
}
