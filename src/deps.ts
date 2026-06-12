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
  /** Serialized input envelope (the connector passes `JSON.stringify(input)`). */
  payload: string;
  /** Blocking budget in ms (the connector passes 300_000 to align with /chat). */
  timeoutMs: number;
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
  /** Configured Drupal instances (host `@/lib/drupal-api` settings). */
  listMcpInstances: () => DrupalMcpInstance[];
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
