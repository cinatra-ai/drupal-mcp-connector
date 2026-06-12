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
};

/** Probe verdict for a Drupal `drupal/mcp_tools` endpoint (host-bound probe). */
export type DrupalMcpProbeStatus = "registered" | "not_installed" | "auth_error" | "unreachable";

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
}

const DRUPAL_DEPS_KEY = Symbol.for("@cinatra-ai/drupal-mcp-connector:host-deps/v1");
type DepsHolder = { [k: symbol]: DrupalConnectorDeps | null | undefined };
const _holder = globalThis as unknown as DepsHolder;

export function registerDrupalConnector(deps: DrupalConnectorDeps): void {
  _holder[DRUPAL_DEPS_KEY] = deps;
}

/** True when the host runtime deps are already bound. Read by the
 * `register(ctx)` bind-if-absent skew guard (src/register.ts): on a host that
 * still binds deps statically at boot (pre transport-DI cutover) the host's
 * eager binding wins; on a cutover host nothing else binds, so register(ctx)
 * binds the lazy capability-resolving deps. Swept once every host the
 * connector can meet is post-cutover. */
export function hasDrupalDeps(): boolean {
  return _holder[DRUPAL_DEPS_KEY] != null;
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
