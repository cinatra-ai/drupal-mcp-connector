import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { DrupalInstanceSettings } from "@/lib/drupal-api";
// The Nango-vault bearer header is resolved via the host DI seam so this
// package carries no `@cinatra-ai/nango-connector` code import. The host
// binds `buildNangoBearerHeader` at boot.
import { getDrupalDeps } from "../deps";

const MCP_TOOLS_PATH = "/_mcp_tools";

/**
 * Resolves the Bearer token from the Nango vault using
 * `instance.nangoConnectionId` instead of reading an instance field. Throws a
 * clear, label-only error if Nango is unavailable or the credential is missing
 * and never includes the token in error messages.
 */
export async function callDrupalMcp(
  instance: DrupalInstanceSettings,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const baseUrl = instance.siteUrl.replace(/\/+$/, "") + MCP_TOOLS_PATH;
  const authHeader = await getDrupalDeps().buildNangoBearerHeader({
    providerConfigKey: instance.providerConfigKey,
    connectionId: instance.nangoConnectionId,
    label: `drupal-${instance.id}`,
  });
  if (!authHeader) {
    throw new Error(
      `Drupal MCP call failed: credential unavailable for site ${instance.siteUrl}`,
    );
  }
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: {
      headers: authHeader,
    },
  });
  const client = new Client({ name: "cinatra-connector-drupal", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: args });
    // Drupal mcp_tools ToolApiCallToolHandler sets structuredContent = { success, message, data }
    // alongside the text content which is prefixed with "Success.\n{json}".
    // Prefer structuredContent (clean JSON) when available; it's the authoritative data.
    const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    if (structured && typeof structured === "object") {
      // Drupal error envelope: { success: false, message: "..." } — surface the real error.
      if ("success" in structured && structured.success === false) {
        const msg = structured.message;
        throw new Error(
          `Drupal ${toolName} returned failure: ${typeof msg === "string" ? msg : JSON.stringify(structured)}`,
        );
      }
      if (!("data" in structured)) return structured;
      const data = structured.data;
      // data: null means Drupal returned the envelope but no payload — callers would get
      // misleading "not found" errors; surface the real cause here instead.
      if (data === null || data === undefined) {
        throw new Error(`Drupal ${toolName}: response envelope has null data`);
      }
      return data;
    }
    // Cast to access content — SDK's CallToolResult has [x: string]: unknown index signature
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    const textItem = Array.isArray(content) ? content.find((c) => c.type === "text") : undefined;
    if (!textItem || typeof textItem.text !== "string") {
      throw new Error(`Drupal ${toolName}: unexpected response format (no text content)`);
    }
    // mcp_tools text is "Success.\n{json}" — strip the known prefix before searching for JSON
    // to avoid false-positive { matches inside an error message preceding the actual JSON.
    const stripped = textItem.text.replace(/^Success\.\s*/, "");
    const jsonStart = stripped.search(/[{[]/);
    const jsonText = jsonStart >= 0 ? stripped.slice(jsonStart) : stripped;
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      // Unwrap { success, message, data } envelope that ToolApiCallToolHandler wraps results in.
      return "data" in parsed ? parsed.data : parsed;
    } catch {
      return textItem.text;
    }
  } finally {
    await client.close().catch(() => {});
  }
}
