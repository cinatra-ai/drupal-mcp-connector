// Wire-level negotiation proof for the Drupal MCP client (cinatra#2218 L2e).
//
// PROOF CLASS — REAL-LIBRARY LOOPBACK, stated honestly and not upgraded.
// The module under test drives the real `@modelcontextprotocol/client@2.0.0`
// over real HTTP against a real `@modelcontextprotocol/server@2.0.0` peer, and
// every frame is read off the wire through an in-process recording proxy. The
// negotiated era is OBSERVED, never inferred from a package version. Both peers
// are in-process, so this needs no container and no network access.
//
// WHAT THIS PROOF DOES NOT COVER, stated rather than implied:
//
//  - It is NOT a live probe of a real Drupal site. This connector's peers are
//    the `/_mcp_tools` endpoints of independently operated, per-instance Drupal
//    installs; this repo has no Drupal container harness and may not reach a
//    customer endpoint from CI, so there is no live leg to run here. The
//    cinatra monorepo owns the Drupal fixture (`docker compose --profile
//    drupal`), and a live probe belongs there, after the pin advance.
//  - Both ends here are the reference TypeScript implementation. A real Drupal
//    peer runs PHP: `drupal/mcp_tools` on `mcp/sdk`. What is established about
//    THAT stack is source-measured rather than wire-measured, and recorded in
//    `../lib/drupal-mcp-client.ts`: the php-sdk `ProtocolVersion` enum carries
//    no 2026 revision in the version the fixture resolves (0.2.2) nor in the
//    current release (0.7.0), and neither ships a `server/discover` handler.
//    So a Drupal peer ANSWERS the probe with an error today — which is exactly
//    the `legacyOnlyPeer` leg below — rather than serving it.
//
// The honest ceiling: this pins CINATRA's side of the negotiation against a
// conformant peer in each era, and pins that the fallback leg still completes a
// real Drupal-shaped tool call end to end.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";

import {
  ProtocolError,
  SdkErrorCode,
  SdkHttpError,
} from "@modelcontextprotocol/client";

import { registerDrupalConnector, _resetDrupalDepsForTests } from "../deps";
import { callDrupalMcp } from "../lib/drupal-mcp-client";

/**
 * The strings an error carries through its OWN data: its message, every own
 * property name (enumerable or not — v2's error classes define `code`/`data`
 * non-enumerably in places), and the `cause` chain, cycle-guarded. A
 * `.message`-only check would miss a leak into `data.text`, which is exactly
 * where `SdkHttpError` parks the raw response body.
 *
 * Deliberately NOT exhaustive over every conceivable carrier: `stack` is
 * skipped (it is source text, and it is noise), and symbol keys, inherited
 * properties, and container contents (Map/Set) are not walked. It is a leak
 * check over the channels these error classes actually use, not a proof that no
 * channel exists.
 */
function errorStrings(err: unknown, seen = new Set<unknown>()): string {
  if (err === null || typeof err !== "object") return String(err);
  if (seen.has(err)) return "";
  seen.add(err);
  const parts: string[] = [];
  for (const key of Object.getOwnPropertyNames(err)) {
    if (key === "stack") continue;
    const value = (err as Record<string, unknown>)[key];
    parts.push(key);
    parts.push(
      value !== null && typeof value === "object"
        ? errorStrings(value, seen)
        : String(value),
    );
  }
  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// The peer: one `mcp_tools`-shaped tool. Its reply is the REAL Drupal envelope
// (`"Success.\n{json}"` text carrying `{ success, message, data }`), so a green
// assertion proves the whole path — negotiate, call, unwrap — not just the
// handshake.
//
// NOTE: the local is named `srv`, never `server` — cinatra's authz-inventory
// scanner inventories REAL MCP primitives by matching a `registerTool` call on
// a variable literally named `server`, and a test fixture must never enter that
// inventory. Same guard the cinatra-side negotiation suites carry.
// ---------------------------------------------------------------------------

const PEER_TOOL = "mcp_tools_get_recent_content";
const PEER_PAYLOAD = { id: "5", title: "Hello" };
const PEER_TEXT = `Success.\n${JSON.stringify({ success: true, message: "ok", data: PEER_PAYLOAD })}`;

function buildPeerServer() {
  const srv = new McpServer({ name: "drupal-mcp-tools-peer", version: "0.0.1" });
  srv.registerTool(
    PEER_TOOL,
    { title: PEER_TOOL, description: "mcp_tools recent-content fixture" },
    async () => ({ content: [{ type: "text" as const, text: PEER_TEXT }] }),
  );
  return srv;
}

/** A peer that implements 2026-07-28 and keeps the 2025-era leg available. */
async function modernPeerHandler(request: Request): Promise<Response> {
  const handler = createMcpHandler(() => buildPeerServer(), { legacy: "stateless" });
  const parsedBody =
    request.method === "POST" ? await request.clone().json().catch(() => undefined) : undefined;
  const response = await handler.fetch(request, { parsedBody });
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    await handler.close().catch(() => undefined);
  }
  return response;
}

/**
 * A peer that speaks the 2025 era ONLY: modern-classified traffic — including
 * the `server/discover` probe — is refused with a JSON-RPC error, which is what
 * selects the client's legacy fallback.
 *
 * This models the Drupal peer class. `drupal/mcp_tools` runs on `mcp/sdk`,
 * whose `ProtocolVersion` enum stops at `2025-11-25` and which registers no
 * `server/discover` handler, so a modern probe gets an ANSWER (an error), not
 * silence. The refusal is a legacy VERDICT for the client, not a failure.
 */
async function legacyOnlyPeerHandler(request: Request): Promise<Response> {
  const srv = buildPeerServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await srv.connect(transport);

  const parsedBody =
    request.method === "POST" ? await request.clone().json().catch(() => undefined) : undefined;

  let legacy = false;
  try {
    legacy = await isLegacyRequest(request, parsedBody);
  } catch {
    legacy = false;
  }
  if (!legacy) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32601, message: "Method not found: server/discover" },
      },
      { status: 400 },
    );
  }
  if (request.method.toUpperCase() !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { status: 405 },
    );
  }
  return transport.handleRequest(request, { parsedBody });
}

/**
 * A hand-rolled peer that reproduces the wire answers a REAL Drupal peer gives,
 * read out of the PHP source rather than invented. `drupal/mcp_tools` 1.0.x
 * exposes `/_mcp_tools` from its `mcp_tools_remote` submodule on `mcp/sdk`
 * ^0.2.2, and three of that SDK's behaviours decide this leg:
 *
 *  1. `Protocol::resolveSession` answers a NON-`initialize` request that
 *     carries no session id with `Error::forInvalidRequest(...)` at HTTP
 *     **400** — JSON-RPC `-32600`, message "A valid session id is REQUIRED for
 *     non-initialize requests." The `server/discover` probe is exactly such a
 *     request, so this is the answer it gets. (An unknown method that DID reach
 *     the message loop would produce the same `-32600` class via
 *     `MessageFactory::findMessageClassByMethod` -> `handleInvalidMessage`.)
 *  2. `MessageInterface::PROTOCOL_VERSION` is **`2025-06-18`**, so the peer
 *     SELECTS that revision on `initialize` — not the `2025-11-25` the client
 *     offers. This leg proves cinatra accepts the server's choice.
 *  3. The peer ASSIGNS a session id on the `initialize` response and requires
 *     it on every post-handshake frame (`resolveSession` answers 404 for an
 *     unknown one). The client never mints one; it stores and replays.
 *
 * That is the same shape L2b/L2d measured live against the WordPress adapter
 * ("400 / -32600 Missing Mcp-Session-Id"), which is why those lanes and this one
 * land on the same mode.
 *
 * SCOPE OF THE CLAIM, deliberately narrow: this fixture is transcribed from
 * `mcp/sdk` **0.2.2** (what `drupal/mcp_tools ^1.0` resolves) and re-checked
 * against **0.7.0** (the current release). It is evidence about THOSE audited
 * versions, not a proof about "every Drupal site" — a site may sit behind a WAF,
 * a reverse proxy, or a patched module, and this repo cannot reach a customer
 * endpoint to find out. Upgrading this leg to a wire measurement needs a
 * version-pinned PHP fixture, which belongs with the cinatra monorepo's Drupal
 * compose profile rather than here.
 */
const DRUPAL_PEER_SESSION_ID = "0198b6c4-7a4d-7c31-9f11-drupalfixture";

function drupalShapedPeerHandler(request: Request): Promise<Response> {
  return (async () => {
    if (request.method.toUpperCase() === "GET" || request.method.toUpperCase() === "DELETE") {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method Not Allowed" } },
        { status: 405 },
      );
    }
    const message = (await request.json().catch(() => ({}))) as { method?: string; id?: unknown };
    const sessionId = request.headers.get("mcp-session-id");

    if (message.method === "initialize") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            // php-sdk `MessageInterface::PROTOCOL_VERSION`.
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "drupal/mcp_tools", version: "1.0.0" },
          },
        },
        { headers: { "Mcp-Session-Id": DRUPAL_PEER_SESSION_ID } },
      );
    }

    if (!sessionId) {
      // `Protocol::resolveSession`, verbatim.
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "A valid session id is REQUIRED for non-initialize requests.",
          },
        },
        { status: 400 },
      );
    }
    if (sessionId !== DRUPAL_PEER_SESSION_ID) {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Session not found or has expired." },
        },
        { status: 404 },
      );
    }

    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/call") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: { content: [{ type: "text", text: PEER_TEXT }] },
      });
    }
    return Response.json(
      { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "Unknown method" } },
      { status: 400 },
    );
  })();
}

/** A peer that answers the probe with a class the client treats as a HARD
 * FAILURE rather than a legacy verdict — used to pin that boundary in the repo
 * instead of only in a comment. `status` selects which. */
function probeHostilePeerHandler(status: number) {
  return async (request: Request): Promise<Response> => {
    const message = (await request.json().catch(() => ({}))) as { method?: string; id?: unknown };
    if (message.method === "server/discover") {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32000, message: "probe refused" } },
        { status },
      );
    }
    // Everything else would have worked — that is the point of the fixture.
    if (message.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "would-have-worked", version: "1" },
        },
      });
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: { content: [{ type: "text", text: PEER_TEXT }] },
    });
  };
}

// ---------------------------------------------------------------------------
// Recording HTTP front end. Every frame the module puts on the wire is captured
// before being handed to the peer.
// ---------------------------------------------------------------------------

type Frame = {
  method: string;
  /** The request PATH — so the `/_mcp_tools` route is proven on the wire. */
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  body: string;
  /** The RESPONSE body, so a refusal's JSON-RPC code can be asserted, not just
   * its HTTP status. */
  responseBody: string;
  /** The JSON-RPC method in the request body, when there is one. */
  rpcMethod: string;
};

/** The JSON-RPC error in a recorded RESPONSE body, when there is one. */
function responseRpcError(frame: Frame): { code?: number; message?: string } | undefined {
  try {
    const parsed = JSON.parse(frame.responseBody) as { error?: { code?: number; message?: string } };
    return parsed.error;
  } catch {
    return undefined;
  }
}

/** A frame reduced to HTTP method, path, JSON-RPC method and status — enough to
 * say two exchanges ran the same sequence of operations against the same route
 * with the same outcomes. Deliberately not headers, arguments or bodies: the
 * comparison it serves is about which FRAMES an era costs, and a header-level
 * diff between the two eras is expected (the modern probe carries `Mcp-Method`,
 * the legacy leg carries a negotiated `MCP-Protocol-Version`). */
const shapeOf = (f: Frame) => `${f.method} ${f.url} rpc=${f.rpcMethod} -> ${f.status}`;

const frames: Frame[] = [];
let listener: http.Server;
let peerUrl = "";
let handleAsPeer: (request: Request) => Promise<Response> = modernPeerHandler;

async function startRecordingPeer(): Promise<string> {
  listener = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const bodyText = body.toString("utf8");

    const requestHeaders: Record<string, string> = {};
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value !== "string") continue;
      requestHeaders[key.toLowerCase()] = value;
      headers.set(key, value);
    }

    let rpcMethod = "";
    try {
      rpcMethod = (JSON.parse(bodyText) as { method?: string }).method ?? "";
    } catch {
      rpcMethod = "";
    }

    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
    });

    let response: Response;
    try {
      response = await handleAsPeer(request);
    } catch (err) {
      response = new Response(String(err), { status: 500 });
    }

    // The RECORD carries the response body too — a refusal's JSON-RPC code, not
    // just its HTTP status, is what the client classifies on, and the
    // Drupal-shaped leg asserts that code.
    //
    // The body is written through AS IT ARRIVES and accumulated alongside,
    // rather than buffered whole and then written: fully buffering first would
    // hold back the headers, which turns a long-lived SSE stream into a hang and
    // destroys streaming semantics on a finite one. The legacy leg's standalone
    // `GET` is exactly such a stream on peers that allow it.
    const frame: Frame = {
      method: req.method ?? "",
      url: req.url ?? "",
      status: response.status,
      requestHeaders,
      body: bodyText,
      responseBody: "",
      rpcMethod,
    };
    frames.push(frame);

    const outHeaders: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) outHeaders[key] = value;
    // The upstream `content-length` describes the upstream body; we re-emit the
    // same bytes, but let node frame them (chunked) rather than risk a stale
    // header on a streamed response.
    delete outHeaders["content-length"];
    res.writeHead(response.status, outHeaders);
    if (!response.body) {
      res.end();
      return;
    }
    const responseChunks: Buffer[] = [];
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      responseChunks.push(buf);
      res.write(buf);
    }
    frame.responseBody = Buffer.concat(responseChunks).toString("utf8");
    res.end();
  });

  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  // The transport appends nothing: the connector builds `<siteUrl>/_mcp_tools`,
  // so the fixture is addressed by the site root and the real path suffix is
  // exercised end to end.
  return `http://127.0.0.1:${port}`;
}

const buildNangoBearerHeader = vi.fn();

function registerDepsForWireProof() {
  registerDrupalConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: vi.fn(async () => ""),
    buildNangoBearerHeader,
    listMcpInstances: () => [],
    probeMcp: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl.replace(/\/+$/, "") + "/_mcp_tools",
    isPrivateUrl: () => false,
    isNangoConfigured: () => true,
    getApiStatus: vi.fn(async () => ({ instanceCount: 0, instances: [] })),
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: vi.fn(async () => []),
    requireInstanceWriteAuthority: vi.fn(async () => {}),
  });
}

const wireInstance = () => ({
  id: "wire",
  name: "Wire Peer",
  siteUrl: peerUrl,
  nangoConnectionId: "wire",
  providerConfigKey: "cinatra-drupal",
  createdAt: "",
  updatedAt: "",
});

beforeAll(async () => {
  peerUrl = await startRecordingPeer();
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

beforeEach(() => {
  frames.length = 0;
  buildNangoBearerHeader.mockReset().mockResolvedValue({ Authorization: "Bearer wire-proof-token" });
  registerDepsForWireProof();
});

afterEach(() => {
  _resetDrupalDepsForTests();
});

const rpcMethods = () => frames.map((f) => f.rpcMethod).filter(Boolean);

describe("callDrupalMcp — negotiated revision, observed on the wire", () => {
  it("reaches 2026-07-28 against a modern peer, with server/discover and NO initialize", async () => {
    handleAsPeer = modernPeerHandler;

    // A real round trip: the Drupal envelope came back over the negotiated era
    // and was unwrapped by the module under test.
    await expect(callDrupalMcp(wireInstance(), PEER_TOOL, {})).resolves.toEqual(PEER_PAYLOAD);

    // The modern era is header-routed: `Mcp-Method` carries the RPC method and
    // `MCP-Protocol-Version` carries the revision on EVERY modern request.
    const probe = frames.find((f) => f.requestHeaders["mcp-method"] === "server/discover");
    expect(probe).toBeDefined();
    expect(probe?.status).toBe(200);
    expect(probe?.requestHeaders["mcp-protocol-version"]).toBe("2026-07-28");

    const call = frames.find((f) => f.requestHeaders["mcp-method"] === "tools/call");
    expect(call).toBeDefined();
    expect(call?.status).toBe(200);
    expect(call?.requestHeaders["mcp-protocol-version"]).toBe("2026-07-28");

    // The retired exchange must not appear anywhere on a modern connection.
    expect(rpcMethods()).not.toContain("initialize");
    expect(rpcMethods()).not.toContain("notifications/initialized");

    // Two frames, no legacy fallback, and no protocol session id anywhere
    // (cinatra#2218 AC4: every surface cinatra controls is stateless on the
    // new revision).
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.requestHeaders["mcp-session-id"]).toBeUndefined();
    }

    // The endpoint really is the connector's `/_mcp_tools` route, not the bare
    // site root — the URL construction is proven on the wire, not only in the
    // mocked suite. (A `host` header assertion would have been vacuous: every
    // HTTP/1.1 request carries one.)
    expect(frames.map((f) => f.url)).toEqual(["/_mcp_tools", "/_mcp_tools"]);
  }, 30_000);

  it("falls back to the 2025-era handshake against a legacy-only peer, and still returns the Drupal payload", async () => {
    handleAsPeer = legacyOnlyPeerHandler;

    await expect(callDrupalMcp(wireInstance(), PEER_TOOL, {})).resolves.toEqual(PEER_PAYLOAD);

    // The probe IS issued — `{ mode: 'auto' }` always asks first — and the peer
    // refuses it. That refusal is what selects the legacy era; it is a verdict,
    // not a failure.
    const probe = frames.find((f) => f.requestHeaders["mcp-method"] === "server/discover");
    expect(probe).toBeDefined();
    expect(probe?.status).toBe(400);

    // ...and then the plain 2025 sequence runs, offering the SDK's revision
    // rather than any connector-authored constant.
    const methods = rpcMethods();
    expect(methods).toContain("initialize");
    expect(methods).toContain("notifications/initialized");
    expect(methods).toContain("tools/call");

    const initialize = frames.find((f) => f.rpcMethod === "initialize");
    expect(initialize?.body).toContain('"protocolVersion":"2025-11-25"');
    // No modern `_meta` envelope may leak onto a legacy exchange.
    expect(initialize?.body).not.toContain("io.modelcontextprotocol/protocolVersion");
  }, 30_000);

  it("costs exactly one extra frame on the legacy leg — the refused probe (the price of `auto`, measured)", async () => {
    handleAsPeer = legacyOnlyPeerHandler;
    await callDrupalMcp(wireInstance(), PEER_TOOL, {});
    const autoFrames = [...frames];
    const autoShapes = autoFrames.map(shapeOf);

    // The same connect-and-call with the mode the graphiti surface uses, driven
    // directly so the comparison is like for like on this exact peer.
    frames.length = 0;
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const legacyClient = new Client(
      { name: "cinatra-connector-drupal", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy" } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${peerUrl}/_mcp_tools`), {
      requestInit: { headers: { Authorization: "Bearer wire-proof-token" } },
    });
    await legacyClient.connect(transport);
    await legacyClient.callTool({ name: PEER_TOOL, arguments: {} });
    await legacyClient.close().catch(() => undefined);
    const legacyShapes = frames.map(shapeOf);

    // This surface opens a FRESH connection per call, so the delta is paid per
    // call. Asserting only `auto - legacy === 1` would pass if `auto` dropped a
    // frame and added two, so the comparison is shape-for-shape: strike the ONE
    // `server/discover` frame from the auto sequence and the two exchanges must
    // be identical.
    const autoWithoutProbe = autoFrames
      .filter((f) => f.rpcMethod !== "server/discover")
      .map(shapeOf);
    expect(autoShapes.length - autoWithoutProbe.length).toBe(1);
    expect(autoWithoutProbe).toEqual(legacyShapes);

    // ...and the absolute counts the module comment quotes are recorded here
    // rather than only asserted as a delta.
    expect(autoShapes).toHaveLength(5);
    expect(legacyShapes).toHaveLength(4);
  }, 30_000);

  it("carries the Nango bearer on EVERY frame, including the negotiation probe", async () => {
    handleAsPeer = modernPeerHandler;
    await callDrupalMcp(wireInstance(), PEER_TOOL, {});

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.requestHeaders.authorization).toBe("Bearer wire-proof-token");
    }
    // ONE credential resolution for the whole connection, not one per HTTP
    // request — the `requestInit.headers` merge, proven on the wire rather than
    // read out of the transport source.
    expect(buildNangoBearerHeader).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("carries the Nango bearer on every frame of the LEGACY leg too, including the refused probe", async () => {
    handleAsPeer = legacyOnlyPeerHandler;
    await callDrupalMcp(wireInstance(), PEER_TOOL, {});

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.requestHeaders.authorization).toBe("Bearer wire-proof-token");
    }
    expect(buildNangoBearerHeader).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("never leaks the resolved credential into a rejection message", async () => {
    handleAsPeer = async () =>
      Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32000, message: "boom" } },
        { status: 500 },
      );

    let caught: unknown;
    try {
      await callDrupalMcp(wireInstance(), PEER_TOOL, {});
    } catch (err) {
      caught = err;
    }
    // The consumer-visible contract this surface's callers actually depend on:
    // an `Error` with a non-empty message. Both hold under client@2.0.0's error
    // classes exactly as they did under sdk@1.29.0's.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.length).toBeGreaterThan(0);
    expect((caught as Error).message).not.toContain("wire-proof-token");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// THE DRUPAL-SHAPED PEER. The closest this proof gets to a real Drupal site
// without a container: the answers are transcribed from `mcp/sdk` ^0.2.2, the
// SDK `drupal/mcp_tools` ^1.0 runs.
// ---------------------------------------------------------------------------
describe("callDrupalMcp against a peer shaped like drupal/mcp_tools on mcp/sdk", () => {
  it("takes the session-required 400/-32600 as a legacy VERDICT and completes the call on the 2025 era", async () => {
    handleAsPeer = drupalShapedPeerHandler;

    await expect(callDrupalMcp(wireInstance(), PEER_TOOL, {})).resolves.toEqual(PEER_PAYLOAD);

    const probe = frames.find((f) => f.requestHeaders["mcp-method"] === "server/discover");
    expect(probe).toBeDefined();
    expect(probe?.status).toBe(400);

    // The specific refusal this leg is named for — asserted from the RESPONSE
    // BODY, so the fixture cannot drift to some other fallback-eligible error
    // while the test keeps claiming `400 / -32600`.
    expect(responseRpcError(probe as Frame)).toMatchObject({
      code: -32600,
      message: "A valid session id is REQUIRED for non-initialize requests.",
    });
    // And the probe reached the peer WITHOUT a session id — which is why the
    // peer answered that way, and is what makes the leg a faithful model.
    expect(probe?.requestHeaders["mcp-session-id"]).toBeUndefined();

    // The refusal did not end the connection — the handshake ran after it.
    expect(rpcMethods()).toContain("initialize");
    expect(rpcMethods()).toContain("tools/call");
  }, 30_000);

  it("accepts the revision the PEER selects (2025-06-18), not the one the client offered", async () => {
    handleAsPeer = drupalShapedPeerHandler;
    await callDrupalMcp(wireInstance(), PEER_TOOL, {});

    // The client offers the SDK's own latest legacy revision...
    const initialize = frames.find((f) => f.rpcMethod === "initialize");
    expect(initialize?.body).toContain('"protocolVersion":"2025-11-25"');

    // ...and the php-sdk peer answers with ITS default. Every post-handshake
    // LEGACY frame then carries the SERVER's choice, which is the interop
    // behaviour the supported-revisions contract records for an older-revision
    // peer. The probe is excluded by construction: it is a MODERN-envelope
    // frame (it is the one that carries `Mcp-Method`), and its own
    // `2026-07-28` header is the revision being probed FOR, not a negotiated
    // one.
    const legacyFrames = frames.filter(
      (f) =>
        f.requestHeaders["mcp-method"] === undefined &&
        f.requestHeaders["mcp-protocol-version"] !== undefined,
    );
    expect(legacyFrames.length).toBeGreaterThan(0);
    for (const frame of legacyFrames) {
      expect(frame.requestHeaders["mcp-protocol-version"]).toBe("2025-06-18");
    }
    // And the probe really was the only modern-header frame — so nothing
    // 2026-era survived onto the negotiated legacy connection.
    const modernFrames = frames.filter((f) => f.requestHeaders["mcp-method"] !== undefined);
    expect(modernFrames.map((f) => f.rpcMethod)).toEqual(["server/discover"]);
  }, 30_000);

  it("AC4: the peer-ASSIGNED session id is replayed by the transport and never escapes into a cinatra value", async () => {
    handleAsPeer = drupalShapedPeerHandler;
    const value = await callDrupalMcp(wireInstance(), PEER_TOOL, {});

    // The peer ASSIGNED the id on its `initialize` response and required it
    // afterwards; the client transport stored and replayed it. Nothing
    // client-side mints a session id. Asserting the replay first is what stops
    // the assertion below from being vacuous on a session-free exchange.
    const replayed = frames.filter(
      (f) => f.requestHeaders["mcp-session-id"] === DRUPAL_PEER_SESSION_ID,
    );
    expect(replayed.length).toBeGreaterThan(0);

    // ...and it stays transport-private: it reaches no returned value. cinatra
    // never reads, persists, routes, or authorizes on it (cinatra#2218 AC4);
    // this module exposes no accessor for it at all.
    expect(JSON.stringify(value)).not.toContain(DRUPAL_PEER_SESSION_ID);
    expect(value).toEqual(PEER_PAYLOAD);
  }, 30_000);

  it("AC4: a SESSIONFUL call that fails surfaces an error carrying the session id NOWHERE — message, own properties, or cause", async () => {
    handleAsPeer = async (request) => {
      const body = (await request.clone().json().catch(() => ({}))) as {
        method?: string;
        id?: unknown;
      };
      if (body.method === "tools/call") {
        // A JSON-RPC failure at HTTP 200 — the shape a permission-denied
        // `mcp_tools` call takes. Deliberately NOT mentioning the session id, so
        // the assertion below is about what the LIBRARY and this module add, not
        // about redacting a peer's own payload (see the note under this test).
        //
        // The `id` ECHO matters: a JSON-RPC error whose id is `null` fails the
        // client's own response validation, and the caller would then see a
        // schema error instead of the error class under test.
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32000, message: "mcp_tools: permission denied" },
        });
      }
      return drupalShapedPeerHandler(request);
    };

    let caught: unknown;
    try {
      await callDrupalMcp(wireInstance(), PEER_TOOL, {});
    } catch (err) {
      caught = err;
    }

    // NOT vacuous: the failure happened on a real, SESSIONFUL `tools/call` —
    // the handshake completed, the peer assigned an id, and the failing frame
    // replayed it. Without this the test would pass on a connection that never
    // reached a session at all.
    const failing = frames.find((f) => f.rpcMethod === "tools/call");
    expect(failing).toBeDefined();
    expect(failing?.requestHeaders["mcp-session-id"]).toBe(DRUPAL_PEER_SESSION_ID);

    // The error is the REAL v2 class for this failure shape, asserted so a
    // wrong assumption about the taxonomy cannot stay green.
    expect(caught).toBeInstanceOf(ProtocolError);
    expect((caught as ProtocolError).code).toBe(-32000);
    expect((caught as Error).message).toBe("mcp_tools: permission denied");

    // ...and the id is absent from EVERY string the error carries, not only
    // `.message`: own enumerable and non-enumerable properties, and the `cause`
    // chain.
    expect(errorStrings(caught)).not.toContain(DRUPAL_PEER_SESSION_ID);
  }, 30_000);

  // The honest boundary of AC4, measured rather than glossed: a peer that puts
  // its OWN session id inside a JSON-RPC error message would have it surface,
  // because this module re-throws the library's error verbatim and never
  // rewrites peer text. AC4 is a claim about what CINATRA does with the id
  // (never read, persist, route or authorize on it) and about the transport not
  // injecting it — not a redaction guarantee over peer-controlled payloads.
  it("AC4 boundary: a peer that writes the id into its OWN error text is NOT redacted (stated, not fixed)", async () => {
    handleAsPeer = async (request) => {
      const body = (await request.clone().json().catch(() => ({}))) as {
        method?: string;
        id?: unknown;
      };
      if (body.method === "tools/call") {
        // Echo the id the CLIENT actually replayed, rather than injecting the
        // constant — so this fixture is only capable of leaking an id that the
        // exchange genuinely established.
        const replayed = request.headers.get("mcp-session-id");
        if (!replayed) {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: body.id ?? null,
              error: { code: -32600, message: "no session on the failing call" },
            },
            { status: 400 },
          );
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32000, message: `denied for session ${replayed}` },
        });
      }
      return drupalShapedPeerHandler(request);
    };

    await expect(callDrupalMcp(wireInstance(), PEER_TOOL, {})).rejects.toThrow(
      DRUPAL_PEER_SESSION_ID,
    );
    // The leak came from the peer's own text on a genuinely sessionful frame.
    const failing = frames.find((f) => f.rpcMethod === "tools/call");
    expect(failing?.requestHeaders["mcp-session-id"]).toBe(DRUPAL_PEER_SESSION_ID);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// THE ERROR TAXONOMY, measured on the wire. The consumer-parity suite
// (`drupal-mcp-error-contract.test.ts`) drives the audited consumers with
// hand-constructed v2 error objects; these two assertions are what license
// those fixtures — they establish which class the library ACTUALLY raises for
// each failure shape, so a wrong assumption there cannot stay green.
// ---------------------------------------------------------------------------
describe("the v2 error classes this surface actually re-throws", () => {
  it("a non-OK HTTP response becomes SdkHttpError (code CLIENT_HTTP_NOT_IMPLEMENTED), with no v1 prefix", async () => {
    handleAsPeer = async (request) => {
      const body = (await request.clone().json().catch(() => ({}))) as {
        method?: string;
        id?: unknown;
      };
      if (body.method === "tools/call") {
        return Response.json(
          { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32000, message: "boom" } },
          { status: 500 },
        );
      }
      return drupalShapedPeerHandler(request);
    };

    let caught: unknown;
    try {
      await callDrupalMcp(wireInstance(), PEER_TOOL, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SdkHttpError);
    expect((caught as SdkHttpError).code).toBe(SdkErrorCode.ClientHttpNotImplemented);
    expect((caught as SdkHttpError).data?.status).toBe(500);
    // v1 raised `StreamableHTTPError` with a "Streamable HTTP error: " prefix.
    expect((caught as Error).message).not.toContain("Streamable HTTP error:");
  }, 30_000);

  it("a JSON-RPC error at HTTP 200 becomes ProtocolError, with no v1 prefix", async () => {
    handleAsPeer = async (request) => {
      const body = (await request.clone().json().catch(() => ({}))) as {
        method?: string;
        id?: unknown;
      };
      if (body.method === "tools/call") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32603, message: "internal error" },
        });
      }
      return drupalShapedPeerHandler(request);
    };

    let caught: unknown;
    try {
      await callDrupalMcp(wireInstance(), PEER_TOOL, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProtocolError);
    expect((caught as ProtocolError).code).toBe(-32603);
    // v1 raised `McpError`, whose message EMBEDDED the code.
    expect((caught as Error).message).not.toContain("MCP error -32603:");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// THE BOUNDARY OF `auto`'s FALLBACK, pinned rather than assumed.
//
// The client's probe classifier does NOT treat every refusal as a legacy
// verdict. A 4xx carrying a JSON-RPC error body falls back (every leg above);
// 401 / 403 / any 5xx do not — they reject the connect. This is the one
// behavioural difference the migration introduces that a real peer could hit,
// so it is measured here instead of being left as a claim.
//
// Why it is accepted for THIS surface: the probe and the `initialize` it would
// replace are the SAME method on the SAME route with the SAME credentials, so
// a peer that answers the probe 401/403 answers `initialize` 401/403 too — the
// pre-migration client failed there as well. The 5xx case is the one that is
// genuinely new, and the php-sdk path measured above shows a conformant
// `mcp_tools` peer answers 400, not 500, to an unknown/session-less method.
// ---------------------------------------------------------------------------
describe("probe refusals that are NOT a legacy verdict", () => {
  it.each([
    ["401 unauthorized", 401],
    ["403 forbidden", 403],
    ["500 server error", 500],
  ])("rejects rather than falling back when the probe is answered %s", async (_label, status) => {
    handleAsPeer = probeHostilePeerHandler(status);

    await expect(callDrupalMcp(wireInstance(), PEER_TOOL, {})).rejects.toBeInstanceOf(Error);

    // The connection stopped AT the probe: no handshake was attempted.
    expect(rpcMethods()).toContain("server/discover");
    expect(rpcMethods()).not.toContain("initialize");
  }, 30_000);

  it("DOES fall back when the same peer answers the probe 404 with a JSON-RPC body", async () => {
    handleAsPeer = probeHostilePeerHandler(404);

    await expect(callDrupalMcp(wireInstance(), PEER_TOOL, {})).resolves.toEqual(PEER_PAYLOAD);
    expect(rpcMethods()).toContain("initialize");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// THE BARE-STRING TRAP, observed rather than read from the source. The peer
// here DOES speak 2026-07-28, and a bare string still lands the connection on
// the 2025 era — a fully working client that silently never negotiated. This is
// what makes `DRUPAL_MCP_VERSION_NEGOTIATION` a TYPED constant rather than an
// inline literal.
// ---------------------------------------------------------------------------
describe("versionNegotiation must be an object", () => {
  it("a bare string silently selects legacy AGAINST A PEER THAT SUPPORTS 2026-07-28", async () => {
    handleAsPeer = modernPeerHandler;
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");

    const withObject = new Client(
      { name: "trap-probe", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await withObject.connect(
      new StreamableHTTPClientTransport(new URL(`${peerUrl}/_mcp_tools`)),
    );
    await withObject.close().catch(() => undefined);
    const objectProbes = frames.filter(
      (f) => f.requestHeaders["mcp-method"] === "server/discover",
    ).length;

    frames.length = 0;

    const withString = new Client(
      { name: "trap-probe", version: "1.0.0" },
      // Deliberately wrong on purpose: this is the shape the migration must not
      // ship. The cast is what a real mistake would look like after the
      // `VersionNegotiationOptions` type stopped catching it.
      { versionNegotiation: "auto" as unknown as { mode: "auto" } },
    );
    await withString.connect(
      new StreamableHTTPClientTransport(new URL(`${peerUrl}/_mcp_tools`)),
    );
    await withString.close().catch(() => undefined);
    const stringProbes = frames.filter(
      (f) => f.requestHeaders["mcp-method"] === "server/discover",
    ).length;
    const stringMethods = frames.map((f) => f.rpcMethod).filter(Boolean);

    expect(objectProbes).toBe(1);
    // No probe at all, and the retired 2025 exchange instead.
    expect(stringProbes).toBe(0);
    expect(stringMethods).toContain("initialize");
  }, 30_000);
});
