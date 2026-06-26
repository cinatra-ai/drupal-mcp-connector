import "server-only";

// First-party Drupal external-MCP toolbox.
//
// Discovered through the generated extension manifest: the package declares
// `cinatra.providesExternalMcpToolbox: true` and the manifest generator records
// this module's factory as a slug-keyed loader entry, so the host's LLM
// toolbox-injection path resolves it WITHOUT importing this package by name.
//
// One MCP server tool per configured Drupal instance whose `drupal/mcp_tools`
// endpoint is reachable. Instance settings, the Nango-vault bearer header, the
// reachability probe, and URL policy (private-URL skip + endpoint resolution)
// are host-bound through the connector deps — this module carries no `@/` or
// non-SDK `@cinatra-ai/*` import.

import type {
  ExtensionExternalMcpTool,
  ExtensionExternalMcpToolbox,
} from "@cinatra-ai/sdk-extensions";
import { getDrupalDeps } from "../deps";

// Explicit tool allowlist for the injected Drupal external MCP server.
// `drupal/mcp_tools` exposes both reads and state-mutating writes; an open
// `allowedTools: null` would expose every present AND future server tool to
// the LLM. Pin the names the connector actually uses.
//   reads  — mcp_tools_search_content, mcp_tools_get_recent_content
//   writes — mcp_update_content, mcp_create_content, mcp_publish_content
const DRUPAL_MCP_READ_TOOLS = [
  "mcp_tools_search_content",
  "mcp_tools_get_recent_content",
] as const;
const DRUPAL_MCP_WRITE_TOOLS = [
  "mcp_update_content",
  "mcp_create_content",
  "mcp_publish_content",
] as const;
const DRUPAL_MCP_ALLOWED_TOOLS: string[] = [
  ...DRUPAL_MCP_READ_TOOLS,
  ...DRUPAL_MCP_WRITE_TOOLS,
];

export function createDrupalExternalMcpToolbox(): ExtensionExternalMcpToolbox {
  return {
    async buildTools(_provider: string): Promise<ExtensionExternalMcpTool[]> {
      try {
        const deps = getDrupalDeps();
        // ACTOR-SCOPED, FAIL-CLOSED instance resolution
        // The external-MCP toolbox injects a
        // credential-bearing MCP server per instance into an LLM call — it MUST
        // only ever expose instances the TRUSTED requesting actor's org is
        // entitled to use, resolved host-side from the MCP request frame. Using
        // the global, unscoped `listMcpInstances()` here is the confused-deputy
        // authz bypass this fix closes. If the host has not bound the
        // actor-scoped lister (old/skewed host), DENY by injecting nothing —
        // never fall back to the unscoped global list.
        const listAuthorized = deps.listAuthorizedMcpInstances;
        if (typeof listAuthorized !== "function") {
          console.warn(
            "[connector-drupal-mcp] actor-scoped instance lister unavailable " +
              "(host listAuthorizedMcpInstances unbound) — injecting no Drupal MCP tools",
          );
          return [];
        }
        // Host resolves the trusted actor and returns ONLY this actor's org's
        // entitled instances; an unresolved/unauthorized actor yields [].
        const instances = await listAuthorized();
        if (!instances || instances.length === 0) return [];
        // Short-circuit when Nango isn't available to avoid per-instance
        // lookups that would all log warnings.
        if (!deps.isNangoConfigured()) {
          console.warn(
            `[connector-drupal-mcp] Nango not configured — skipping ${instances.length} Drupal instance(s)`,
          );
          return [];
        }
        const tools: ExtensionExternalMcpTool[] = [];
        for (const instance of instances) {
          if (deps.isPrivateUrl(instance.siteUrl)) {
            console.log(
              `[connector-drupal-mcp] ${instance.siteUrl} is private — skipping (LLM providers cannot reach localhost)`,
            );
            continue;
          }
          // Resolve the Bearer header from the Nango vault via the host-bound
          // helper so the token never touches this module.
          const headers = await deps.buildNangoBearerHeader({
            providerConfigKey: instance.providerConfigKey,
            connectionId: instance.nangoConnectionId,
            label: `drupal-${instance.id}`,
          });
          if (!headers) {
            // Helper already warned with the label.
            continue;
          }
          const status = await deps.probeMcp(instance.siteUrl, headers.Authorization);
          if (status !== "registered") {
            console.log(`[connector-drupal-mcp] ${instance.siteUrl} status=${status} — skipping`);
            continue;
          }
          tools.push({
            type: "mcp",
            serverLabel: `drupal-${instance.id}`,
            serverUrl: deps.resolveMcpServerUrl(instance.siteUrl),
            headers,
            serverDescription: `Drupal site ${instance.name} (${instance.siteUrl}) — drupal/mcp_tools`,
            // Explicit allowlist — never `null` (which would expose every present
            // and future server tool).
            allowedTools: [...DRUPAL_MCP_ALLOWED_TOOLS],
            // Require human approval for the injected tools — the connector no
            // longer auto-approves Drupal MCP calls (was "never"). The allowlist
            // is read+write and the SDK contract's `requireApproval` only carries
            // the coarse "never" | "always" | "read-only" union (no per-tool
            // object), so "always" is used to fail-closed across the
            // state-mutating update/create/publish tools rather than
            // auto-approving any of them.
            requireApproval: "always",
          });
        }
        return tools;
      } catch (err) {
        console.warn(
          "[connector-drupal-mcp] external-MCP toolbox build failed",
          err instanceof Error ? err.message : String(err),
        );
        return [];
      }
    },
  };
}
