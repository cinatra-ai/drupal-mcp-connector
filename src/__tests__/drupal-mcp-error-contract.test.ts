// CONSUMER-CONTRACT PARITY for the cinatra#2218 L2e client migration.
//
// The migration changes the CLASS of error a failed `callDrupalMcp` rejects
// with — `StreamableHTTPError` / `McpError` (v1, with the message prefixes
// "Streamable HTTP error: " and "MCP error <code>: ") become `SdkHttpError` /
// `ProtocolError` (v2, no prefixes). That is only safe because the consumers do
// not discriminate on either.
//
// WHAT THIS FILE ESTABLISHES, and what it does not. It drives the two DECISIONS
// that a class change could have flipped — the fail-CLOSED content-write gate
// and the fail-SOFT read fallback — with rejections of both shapes, and shows
// the decision is identical. It does NOT prove "no consumer anywhere
// discriminates": that is an audit result, recorded with its search in
// `../lib/drupal-mcp-client.ts`, and the audit is what selected these two as
// the decisions worth locking. The remaining in-package consumer is one
// `console.warn` in `mcp/toolbox.ts` that reads `err.message`.
//
// The v2 fixtures below are not guesses. The class, code and message shape of
// each was MEASURED on the wire in `drupal-mcp-client-negotiation.test.ts`
// ("the v2 error classes this surface actually re-throws"), which drives real
// failures through the real library; these constructors reproduce exactly what
// it observed.
//
// Why this file exists at all rather than trusting the audit: one of these
// consumers is a CONTENT-WRITE GATE. `evaluateStagedNodeWrite` refuses a
// review-gated Drupal write when the full-field MCP read is unavailable —
// fail-CLOSED. If an error class the gate could not recognise had ever been
// allowed to read as "no error", the write would reach Drupal with no captured
// review target. The sibling marketplace surface had exactly that defect shape
// (cinatra#2218 L2b: a class-keyed gate that would have failed OPEN), so the
// direction is asserted here rather than assumed.
//
// The v2 error objects are constructed from the REAL package, not hand-rolled,
// so a future change to their shape shows up here.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SdkHttpError, SdkErrorCode, ProtocolError } from "@modelcontextprotocol/client";

vi.mock("../lib/drupal-mcp-client", () => ({
  callDrupalMcp: vi.fn(),
}));

import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "../mcp/handlers";
import { registerDrupalConnector, _resetDrupalDepsForTests, type CmsReviewSeam } from "../deps";

// ---------------------------------------------------------------------------
// The failure shapes, before and after. Each pair is the SAME underlying
// failure expressed in the two libraries' vocabularies.
// ---------------------------------------------------------------------------

/** v1 `StreamableHTTPError`: a plain Error whose message carried the prefix. */
function v1HttpError(status: number, text: string): Error {
  const err = new Error(`Streamable HTTP error: ${status} ${text}`);
  // v1's class set `name` to "Error" — the prefix WAS the identity.
  return err;
}

/** v1 `McpError`: a plain Error whose message EMBEDDED the JSON-RPC code. */
function v1McpError(code: number, message: string): Error {
  return new Error(`MCP error ${code}: ${message}`);
}

const FAILURES: Array<[label: string, make: () => unknown]> = [
  ["v1 StreamableHTTPError (HTTP 500)", () => v1HttpError(500, "Internal Server Error")],
  ["v1 McpError (-32603)", () => v1McpError(-32603, "internal error")],
  [
    // The exact code + message the v2 transport raises for a non-OK POST
    // (`SdkErrorCode.ClientHttpNotImplemented`, "Error POSTing to endpoint: …"),
    // so this fixture is the real failure shape rather than a plausible one.
    "v2 SdkHttpError (HTTP 500)",
    () =>
      new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Error POSTing to endpoint: boom", {
        status: 500,
        statusText: "Internal Server Error",
        text: "boom",
      }),
  ],
  ["v2 ProtocolError (-32603)", () => new ProtocolError(-32603, "internal error")],
  ["v2 transport-level TypeError (peer unreachable)", () => new TypeError("fetch failed")],
];

const INSTANCE = {
  id: "d-1",
  name: "Site",
  siteUrl: "https://example.test",
  nangoConnectionId: "d-1",
  providerConfigKey: "cinatra-drupal",
  createdAt: "",
  updatedAt: "",
};

function makeSeam(overrides: Partial<CmsReviewSeam> = {}): CmsReviewSeam {
  return {
    isReviewActive: () => true,
    captureStagedWrite: vi.fn(async () => ({
      operationId: "op-1",
      gate: { gateId: "g-1", runId: "r-1" },
      disposition: "pending" as const,
      pending: { held: true },
    })),
    resolveDisposition: vi.fn(async () => ({ disposition: "pending" as const, gate: null })),
    recordApplyVerification: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as CmsReviewSeam;
}

function registerDeps(seam?: CmsReviewSeam) {
  registerDrupalConnector({
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items, total, offset, limit) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: vi.fn(async () => ""),
    buildNangoBearerHeader: vi.fn(async () => ({ Authorization: "Bearer t" })),
    listMcpInstances: () => [INSTANCE],
    probeMcp: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl.replace(/\/+$/, "") + "/_mcp_tools",
    isPrivateUrl: () => false,
    isNangoConfigured: () => true,
    getApiStatus: vi.fn(async () => ({ instanceCount: 1, instances: [INSTANCE] })),
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: vi.fn(async () => []),
    requireInstanceWriteAuthority: vi.fn(async () => {}),
    ...(seam ? { cmsReview: seam } : {}),
  });
}

beforeEach(() => {
  vi.mocked(callDrupalMcp).mockReset();
});

afterEach(() => {
  _resetDrupalDepsForTests();
});

// ---------------------------------------------------------------------------
// 1. The content-write gate. FAIL-CLOSED must survive the class swap.
// ---------------------------------------------------------------------------
describe("staged-write review gate — fail-CLOSED on an unavailable MCP read", () => {
  it.each(FAILURES)(
    "refuses drupal_node_update and writes NOTHING when the current-node read rejects with %s",
    async (_label, make) => {
      const seam = makeSeam();
      registerDeps(seam);
      // The full-field read is the FIRST call; it fails. Any later call would be
      // the write itself — which must never happen.
      vi.mocked(callDrupalMcp).mockRejectedValue(make());

      const handlers = createDrupalPrimitiveHandlers();
      await expect(
        handlers.drupal_node_update({
          input: { instanceId: "d-1", nodeId: "5", fields: { title: "new" } },
        } as never),
      ).rejects.toThrow(/unavailable/);

      // The gate refused BEFORE any write. Asserted as the EXACT call sequence
      // rather than "the write is absent": the only MCP call made was the
      // full-field read that failed, so there is no room for a second path to
      // have reached Drupal.
      expect(seam.captureStagedWrite).not.toHaveBeenCalled();
      expect(vi.mocked(callDrupalMcp).mock.calls.map((c) => c[1])).toEqual([
        "mcp_jsonapi_list_entities",
      ]);
    },
  );

  it.each(FAILURES)(
    "refuses drupal_node_publish and publishes NOTHING when the current-node read rejects with %s",
    async (_label, make) => {
      const seam = makeSeam();
      registerDeps(seam);
      vi.mocked(callDrupalMcp).mockRejectedValue(make());

      const handlers = createDrupalPrimitiveHandlers();
      await expect(
        handlers.drupal_node_publish({ input: { instanceId: "d-1", nodeId: "5" } } as never),
      ).rejects.toThrow(/unavailable/);

      expect(seam.captureStagedWrite).not.toHaveBeenCalled();
      expect(vi.mocked(callDrupalMcp).mock.calls.map((c) => c[1])).toEqual([
        "mcp_jsonapi_list_entities",
      ]);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. The read fallback. FAIL-SOFT must also survive the class swap — the other
//    direction of the same audit. A gate that stopped falling back would turn a
//    transient jsonapi outage into a hard read failure.
// ---------------------------------------------------------------------------
describe("drupal_node_get — fail-SOFT fallback to the recent-content summary", () => {
  it.each(FAILURES)(
    "falls back to mcp_tools_get_recent_content when the full-field read rejects with %s",
    async (_label, make) => {
      registerDeps();
      let call = 0;
      vi.mocked(callDrupalMcp).mockImplementation(async () => {
        call += 1;
        if (call === 1) throw make() as Error;
        return { content: [{ id: 5, title: "From summary" }] };
      });

      const handlers = createDrupalPrimitiveHandlers();
      const node = await handlers.drupal_node_get({
        input: { instanceId: "d-1", nodeId: "5" },
      } as never);

      expect(node).toMatchObject({ id: 5 });
      // The EXACT sequence: the full-field read, then the summary fallback.
      expect(vi.mocked(callDrupalMcp).mock.calls.map((c) => c[1])).toEqual([
        "mcp_jsonapi_list_entities",
        "mcp_tools_get_recent_content",
      ]);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. The whole consumer-visible contract, stated as an assertion: every shape
//    above is an `Error` with a non-empty message. That — not the class, and
//    not the v1 message prefix — is what the audited consumers actually read.
// ---------------------------------------------------------------------------
describe("the surface the consumers read", () => {
  // Not a proof that consumers read only this — that is the audit's job, and the
  // two decision suites above are where it is locked. This pins the property the
  // audited consumers DO read (`mcp/toolbox.ts` stringifies `err.message`),
  // across both vocabularies, so a v2 shape that stopped being an `Error` or
  // arrived message-less would fail here rather than degrade a log line.
  it.each(FAILURES)("%s is an Error with a non-empty message", (_label, make) => {
    const err = make();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.length).toBeGreaterThan(0);
  });

  it("the v2 classes do NOT carry v1's message prefixes — the reason no consumer may parse them", () => {
    const httpErr = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Error POSTing to endpoint: boom", {
      status: 500,
      statusText: "Internal Server Error",
      text: "boom",
    });
    const rpcErr = new ProtocolError(-32603, "internal error");
    expect(httpErr.message).not.toContain("Streamable HTTP error:");
    expect(rpcErr.message).not.toContain("MCP error -32603:");
  });
});
