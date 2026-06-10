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

export function createDrupalExternalMcpToolbox(): ExtensionExternalMcpToolbox {
  return {
    async buildTools(_provider: string): Promise<ExtensionExternalMcpTool[]> {
      try {
        const deps = getDrupalDeps();
        const instances = deps.listMcpInstances();
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
            allowedTools: null,
            requireApproval: "never",
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
