import "server-only";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { VersionNegotiationOptions } from "@modelcontextprotocol/client";

// The Nango-vault bearer header is resolved via the host DI seam so this
// package carries no `@cinatra-ai/nango-connector` code import. The host
// binds `buildNangoBearerHeader` at boot. The instance row type is the
// connector-local STRUCTURAL `DrupalMcpInstance` (cinatra#172 Stage H2) —
// `@/lib/drupal-api`'s `DrupalInstanceSettings` stays host-side and this
// client only reads the pointer fields below.
import { getDrupalDeps, type DrupalMcpInstance } from "../deps";

const MCP_TOOLS_PATH = "/_mcp_tools";

// ---------------------------------------------------------------------------
// THE PACKAGE, AND WHY THIS ONE IS DECLARED (cinatra#2218 L2e).
//
// This module used to import `@modelcontextprotocol/sdk` — WITHOUT declaring
// it. It resolved through the cinatra host's root `node_modules/` symlink,
// which pnpm's default isolated linker publishes only for a DIRECT dependency
// of the ROOT importer. So the host's own root manifest was the single thing
// keeping this connector's imports resolvable: a phantom dependency. Measured
// on cinatra#2218 L2z: deleting only that root line and re-installing dropped
// the symlink, and a `createRequire` probe from THIS file then returned
// `MODULE_NOT_FOUND` for both specifiers while the host typecheck went from
// exit 0 to three `TS2307`s — all three inside this connector.
//
// `@modelcontextprotocol/client` is therefore declared in this package's OWN
// `package.json` `dependencies`, exact-pinned `2.0.0` to match the four cinatra
// surfaces migrated ahead of this one (cinatra#2218 L2a–L2d). This is a PACKAGE
// migration, not a version bump: `@modelcontextprotocol/sdk@1.30.0` contains
// zero occurrences of `2026-07-28`, so the v1 line is not a route to the
// revision at all.
//
// ---------------------------------------------------------------------------
// PROTOCOL-REVISION NEGOTIATION — EXPLICIT auto.
//
// The peers on this surface are the `/_mcp_tools` endpoints of INDEPENDENTLY
// OPERATED, PER-INSTANCE Drupal sites: one per `DrupalMcpInstance` row, at a
// `siteUrl` the site owner controls and cinatra neither pins nor upgrades.
// There is no single peer whose era could be settled once in this source, so
// per-peer negotiation is the only posture that can be right for every row at
// once. That is the same reasoning the connector-instance transport (L2d) and
// the marketplace client (L2b) landed on, and it is what the supported-
// revisions contract records as the standing outbound policy.
//
// The peer class IS 2025-era today, and that is measured rather than assumed —
// but measured on a version RANGE cinatra does not control, which is exactly
// why it does not license explicit `{ mode: "legacy" }`. The chain, read at
// this change:
//
//   docker/drupal/Dockerfile (the CI fixture) requires `drupal/mcp_tools:^1.0`
//     -> mcp_tools 1.0.x composer.json requires `mcp/sdk:^0.2.2`
//     -> php-sdk 0.2.2 `Schema/Enum/ProtocolVersion` enumerates ONLY
//        2025-03-26 / 2025-06-18 / 2025-11-25, and `MessageInterface::
//        PROTOCOL_VERSION` defaults to 2025-06-18.
//
// The current php-sdk release (0.7.0) still enumerates no 2026 revision and
// contains no `server/discover` handler, so no Drupal peer can answer the
// modern probe today. But `^1.0` / `^0.2.2` are CARET RANGES on contrib
// software installed per site: a site owner updating their own Drupal moves
// this peer with no change in this repo and no signal that would prompt one.
// The explicit-legacy exception the contract doc allows is scoped to a peer
// that is known 2025-era AND PINNED (the graphiti image, digest-pinned in
// cinatra's compose file) — this surface fails the pinned half, so `auto` is
// the policy applied, not an exception to it.
//
// COST, stated rather than hidden: `callDrupalMcp` opens a FRESH connection per
// call, so the refused probe is paid per call, not once per process. Measured
// in `drupal-mcp-client-negotiation.test.ts` on the real libraries: 5 frames
// per connect-and-call against a 2025-era peer under `{ mode: "auto" }` vs 4
// under `{ mode: "legacy" }` — one extra round trip. Against a peer that DOES
// answer, the modern leg is 2 frames and issues no `initialize` at all.
//
// THE TRAP, and why this is a typed constant. `versionNegotiation` is an
// OPTIONS OBJECT whose `mode` defaults to `'legacy'`: the client resolves
// `options?.mode ?? 'legacy'`, so a bare string (`versionNegotiation: "auto"`)
// leaves `mode` undefined and silently takes the legacy path — a fully working
// client that never negotiated, with nothing anywhere reporting it. Two guards:
// this constant is typed `VersionNegotiationOptions`, so a bare string is a
// compile error at the call site below; and the negotiation test drives the
// bare-string form against a modern peer and observes it land on 2025-11-25.
//
// SESSIONS (cinatra#2218 AC4). A 2025-era Drupal peer may require a session
// handshake — `mcp/sdk`'s `Protocol::resolveSession` does. On that leg the id
// is ASSIGNED BY THE PEER (it comes back on the `initialize` response; nothing
// client-side mints one), then stored and replayed by the client transport, and
// it stays transport-private: this connector never reads, persists, routes, or
// authorizes on it, and it reaches no return value, no error and no log line.
// ---------------------------------------------------------------------------
export const DRUPAL_MCP_VERSION_NEGOTIATION: VersionNegotiationOptions = { mode: "auto" };

// ---------------------------------------------------------------------------
// ERROR TAXONOMY across this migration, and the consumer audit behind leaving
// it un-normalized.
//
// The classes this module RE-THROWS from the library changed:
//
//   failure mode                  sdk@1.29.0               client@2.0.0
//   ----------------------------  -----------------------  --------------------
//   peer unreachable              TypeError "fetch failed" TypeError "fetch failed"
//   peer answers HTTP 4xx/5xx     StreamableHTTPError      SdkHttpError
//                                 (name "Error", message   (name "SdkHttpError",
//                                  prefixed "Streamable     no prefix)
//                                  HTTP error: ")
//   peer answers a JSON-RPC error McpError ("MCP error     ProtocolError
//                                  <code>: ...")            (no prefix)
//
// Every consumer of a `callDrupalMcp` rejection was audited before the package
// changed, because the fail-open direction here is a content-write gate:
//
//   - `handlers.ts` `readNodeForReview` — bare `catch {}` -> `null`, and a null
//     current read is FAIL-CLOSED in `evaluateStagedNodeWrite` (the staged write
//     is REJECTED, not passed). Class-agnostic; the fail-closed direction is
//     preserved and is locked by a test in this package.
//   - `handlers.ts` `drupal_node_get` — bare `catch {}` around the full-field
//     MCP read, falling back to the recent-content summary. Class-agnostic.
//   - `mcp/toolbox.ts` — `err instanceof Error ? err.message : String(err)` for
//     one `console.warn`. Message TEXT only, no prefix parsing.
//   - No other in-package catch touches this path, and NOTHING host-side
//     discriminates a Drupal MCP failure: the host's `drupal-mcp-connection.ts`
//     issues `HEAD` reachability probes and carries no MCP traffic. Whole-repo
//     search for the v1 message prefixes ("Streamable HTTP error: ",
//     "MCP error <code>: ") finds exactly one consumer in cinatra, and it is the
//     MARKETPLACE surface (`vendor-application-cm-errors.ts`), migrated by L2b.
//
// So `instanceof Error` and a non-empty `.message` are the entire
// consumer-visible contract on this path, and both hold identically before and
// after. Reconstructing v1's class names and message prefixes would be dead
// abstraction that discards v2's richer error identity.
//
// Errors this module raises ITSELF — the credential-unavailable error, the
// Drupal failure-envelope error, the null-data error and the
// unexpected-response-format error — are byte-identical to pre-migration and
// are locked by the behavior-parity suite.
// ---------------------------------------------------------------------------

/**
 * Resolves the Bearer token from the Nango vault using
 * `instance.nangoConnectionId` instead of reading an instance field. Throws a
 * clear, label-only error if Nango is unavailable or the credential is missing
 * and never includes the token in error messages.
 */
export async function callDrupalMcp(
  instance: DrupalMcpInstance,
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
    // `requestInit.headers` is MERGED into every request the transport makes
    // (`normalizeHeaders(this._requestInit?.headers)` in `_commonHeaders`), on
    // both the modern probe and the 2025-era fallback — so the Nango bearer
    // travels on EVERY frame, including `server/discover`. That is asserted on
    // the wire rather than assumed.
    //
    // NOTE for anyone extending this: `requestInit.signal` would NOT be
    // honoured — the transport builds each request as
    // `{ ...requestInit, method, headers, signal }`, so its own signal
    // overwrites a caller's. A real deadline goes on the transport's `fetch`
    // option or on `connect()`/`callTool()`'s protocol-level `timeout`. No
    // deadline is set here because the pre-migration client set none either;
    // adding one would be a behaviour change, not a migration.
    requestInit: {
      headers: authHeader,
    },
  });
  const client = new Client(
    { name: "cinatra-connector-drupal", version: "1.0.0" },
    { versionNegotiation: DRUPAL_MCP_VERSION_NEGOTIATION },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: args });
    // Drupal mcp_tools ToolApiCallToolHandler sets structuredContent = { success, message, data }
    // alongside the text content which is prefixed with "Success.\n{json}".
    // Prefer structuredContent (clean JSON) when available; it's the authoritative data.
    // `structuredContent` is a DECLARED field on client@2.0.0's `CallToolResult`
    // (v1 needed a whole-result cast to reach it) but is typed `unknown`, so the
    // cast narrows the value, not the field's existence.
    const structured = result.structuredContent as Record<string, unknown> | undefined;
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
    // `content` is a DECLARED array field on client@2.0.0's `CallToolResult`
    // (v1 needed the same whole-result cast as `structuredContent`), but the
    // `Array.isArray` guard is KEPT rather than trusting the type: it is what
    // turns a malformed result into this module's own "unexpected response
    // format" error instead of a `TypeError` on `.find()`, and dropping it
    // would change behaviour on exactly the path the parity suite pins.
    const content = result.content;
    const textItem = Array.isArray(content) ? content.find((c) => c.type === "text") : undefined;
    if (!textItem || !("text" in textItem) || typeof textItem.text !== "string") {
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
