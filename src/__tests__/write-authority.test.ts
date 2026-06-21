// cinatra#409 — per-user / per-connector-instance write authorization.
//
// These tests prove the handler-side enforcement contract that makes the
// per-user token reaching the MCP boundary (post-#407/#408) load-bearing for
// Drupal CMS writes: EVERY write primitive (drupal_node_update,
// drupal_node_create_draft_revision, drupal_node_publish) calls the host dep
// `requireInstanceWriteAuthority({ instanceId, primitiveName })` AFTER resolving
// the instance and BEFORE any write reaches callDrupalMcp, and FAILS CLOSED when
// the gate denies (throws), the host actor is unresolved (null), or the dep is
// unbound on an old/skewed host.
//
// Identity is HOST-DERIVED ONLY — the dep reads the trusted MCP request frame
// host-side; the connector never passes a user identity through tool input or
// the SDK `request.actor` field. So here we model the host decision by the dep
// mock's resolve (allow) / reject (deny), matching how the real
// requireConnectorAuthority + the suppressed-platform-admin widget path behave.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/drupal-mcp-client", () => ({
  callDrupalMcp: vi.fn(),
}));

import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "@cinatra-ai/drupal-mcp-connector/mcp-handlers";
import {
  registerDrupalConnector,
  _resetDrupalDepsForTests,
} from "../deps";

const listMcpInstancesMock = vi.fn((): any[] => []);
// The host write-authority gate. Default = ALLOW; individual tests override it
// to DENY (reject) to model non-member / member-without-right / null-actor /
// cross-org / suppressed-platform-admin decisions.
const requireInstanceWriteAuthorityMock = vi.fn(
  async (_input: { instanceId: string; primitiveName: string }) => {},
);

// Fixture instances. site-A is in the verified-origin org; site-B models an
// instanceId that resolves locally but belongs to a DIFFERENT org — the host
// requireConnectorAuthority keys on actor.organizationId, so the gate denies it
// for an actor whose verified origin is org A.
const inst = (id: string) => ({
  id,
  name: id,
  siteUrl: `http://localhost:8082/${id}`,
  nangoConnectionId: id,
  providerConfigKey: "cinatra-drupal",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

function registerDepsStub(over?: {
  requireInstanceWriteAuthority?: unknown;
  omitGate?: boolean;
}) {
  const base: any = {
    decodeCursor: (cursor?: string) => (cursor ? Number(cursor) : 0),
    buildListPage: (items: any[], total: number, offset: number, limit: number) => ({
      items,
      total,
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
    }),
    dispatchContentEditor: vi.fn(async () => ""),
    buildNangoBearerHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
    listMcpInstances: listMcpInstancesMock,
    probeMcp: async () => "registered" as const,
    resolveMcpServerUrl: (siteUrl: string) => siteUrl.replace(/\/+$/, "") + "/_mcp_tools",
    isPrivateUrl: () => false,
    isNangoConfigured: () => true,
    getApiStatus: vi.fn(async () => ({ instanceCount: 0, instances: [] })),
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: vi.fn(async () => []),
    requireInstanceWriteAuthority: requireInstanceWriteAuthorityMock,
  };
  if (over?.omitGate) {
    // Model an OLD host that never bound the gate (dep absent).
    delete base.requireInstanceWriteAuthority;
  } else if (over?.requireInstanceWriteAuthority !== undefined) {
    base.requireInstanceWriteAuthority = over.requireInstanceWriteAuthority;
  }
  registerDrupalConnector(base);
}

describe("cinatra#409 — per-user write authorization in the Drupal MCP write handlers", () => {
  let handlers: ReturnType<typeof createDrupalPrimitiveHandlers>;

  beforeEach(() => {
    handlers = createDrupalPrimitiveHandlers();
    listMcpInstancesMock.mockReset();
    listMcpInstancesMock.mockReturnValue([inst("site-A"), inst("site-B")]);
    requireInstanceWriteAuthorityMock.mockReset();
    requireInstanceWriteAuthorityMock.mockResolvedValue(undefined);
    vi.mocked(callDrupalMcp).mockReset();
    vi.mocked(callDrupalMcp).mockResolvedValue({ ok: true });
    registerDepsStub();
  });

  afterEach(() => {
    _resetDrupalDepsForTests();
  });

  const writeCases = [
    {
      primitive: "drupal_node_update",
      input: { instanceId: "site-A", nodeId: "5", fields: { title: "New" } },
    },
    {
      primitive: "drupal_node_create_draft_revision",
      input: { instanceId: "site-A", nodeBundle: "article", title: "Draft" },
    },
    {
      primitive: "drupal_node_publish",
      input: { instanceId: "site-A", nodeId: "5" },
    },
  ] as const;

  // ---- ALLOW: entitled user -> write proceeds ----
  for (const { primitive, input } of writeCases) {
    it(`${primitive}: entitled user -> the gate is invoked with the named instance, then the write dispatches`, async () => {
      await (handlers as any)[primitive]({
        primitiveName: primitive,
        input,
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      });
      // Gate was asked about the EXACT instanceId argument + the primitive name.
      expect(requireInstanceWriteAuthorityMock).toHaveBeenCalledWith({
        instanceId: "site-A",
        primitiveName: primitive,
      });
      // Only after the gate allowed does the write reach the Drupal site.
      expect(callDrupalMcp).toHaveBeenCalledTimes(1);
    });
  }

  // ---- DENY (throws) for every host decision class; NO write dispatched ----
  const denyDecisions = [
    { name: "non-member of the org", reason: "not a member" },
    { name: "member WITHOUT the connector/instance use-right", reason: "no use right" },
    {
      name: "platform admin on the public_site_widget path (bypass NOT honored, #408)",
      reason: "platform_admin suppressed on widget path",
    },
    { name: "no trusted user context (null actor: missing userId/orgId)", reason: "null actor" },
    {
      name: "forged DIFFERENT-org instanceId (enforceConnectorPolicy keys on actor.organizationId)",
      reason: "cross-org instance",
    },
    {
      name: "forged SAME-org instanceId the user is not entitled to",
      reason: "same-org unauthorized instance",
    },
  ] as const;

  for (const { primitive, input } of writeCases) {
    for (const { name, reason } of denyDecisions) {
      it(`${primitive}: DENIED (${name}) -> throws and NEVER writes`, async () => {
        requireInstanceWriteAuthorityMock.mockRejectedValueOnce(
          new Error(`write denied: ${reason}`),
        );
        await expect(
          (handlers as any)[primitive]({
            primitiveName: primitive,
            input,
            actor: { actorType: "model", source: "agent" },
            mode: "agentic",
          }),
        ).rejects.toThrow(/denied/i);
        // FAIL-CLOSED: the gate threw, so the write must never reach the site.
        expect(callDrupalMcp).not.toHaveBeenCalled();
      });
    }
  }

  // ---- The gate must run BEFORE the write, not after ----
  it("drupal_node_update: the authority gate runs BEFORE callDrupalMcp (deny pre-empts the write)", async () => {
    const order: string[] = [];
    requireInstanceWriteAuthorityMock.mockImplementationOnce(async () => {
      order.push("authz");
      throw new Error("write denied: ordering");
    });
    vi.mocked(callDrupalMcp).mockImplementation(async () => {
      order.push("write");
      return { ok: true } as any;
    });
    await expect(
      (handlers as any).drupal_node_update({
        primitiveName: "drupal_node_update",
        input: { instanceId: "site-A", nodeId: "5", fields: { title: "New" } },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/denied/i);
    expect(order).toEqual(["authz"]); // authz ran; write never did.
  });

  // ---- Fail-closed when the host dep is UNBOUND (old host) ----
  it("FAILS CLOSED when requireInstanceWriteAuthority is unbound on an old host (no fallback write)", async () => {
    _resetDrupalDepsForTests();
    registerDepsStub({ omitGate: true });
    await expect(
      (handlers as any).drupal_node_update({
        primitiveName: "drupal_node_update",
        input: { instanceId: "site-A", nodeId: "5", fields: { title: "New" } },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/write-authority gate is unavailable|unbound|denied/i);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the bound gate is not a function (skewed/partial host binding)", async () => {
    _resetDrupalDepsForTests();
    registerDepsStub({ requireInstanceWriteAuthority: "not-a-function" as unknown });
    await expect(
      (handlers as any).drupal_node_publish({
        primitiveName: "drupal_node_publish",
        input: { instanceId: "site-A", nodeId: "5" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/write-authority gate is unavailable|unbound|denied/i);
    expect(callDrupalMcp).not.toHaveBeenCalled();
  });

  // ---- READS are unchanged: no authority gate on the read path ----
  it("READS (drupal_node_list, drupal_status, drupal_instances_list) do NOT invoke the write-authority gate", async () => {
    // status
    await (handlers as any).drupal_status({
      primitiveName: "drupal_status",
      input: {},
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    // instances_list
    await (handlers as any).drupal_instances_list({
      primitiveName: "drupal_instances_list",
      input: {},
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    // node_list
    vi.mocked(callDrupalMcp).mockResolvedValueOnce({ content: [] });
    await (handlers as any).drupal_node_list({
      primitiveName: "drupal_node_list",
      input: { instanceId: "site-A" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    // node_get — JSON:API read path (the field-level-diff read). Stub fetch to
    // return one bundle + one matching node so the read resolves without the
    // summary fallback. This is a READ, so the write gate must NOT fire.
    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ type: "node_type--node_type", id: "u-a", attributes: { drupal_internal__type: "article" } }],
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ type: "node--article", id: "uuid-5", attributes: { drupal_internal__nid: 5, title: "T", body: { value: "B" } } }],
          }),
        } as unknown as Response);
      await (handlers as any).drupal_node_get({
        primitiveName: "drupal_node_get",
        input: { instanceId: "site-A", nodeId: "5" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(requireInstanceWriteAuthorityMock).not.toHaveBeenCalled();
  });

  // ---- A DENY on the read path's instance does NOT block the read (reads are
  //      gated by membership at the boundary, not per-user write entitlement) ----
  it("drupal_node_list still works even when the write-authority gate would deny (reads bypass the write gate)", async () => {
    requireInstanceWriteAuthorityMock.mockRejectedValue(new Error("write denied"));
    vi.mocked(callDrupalMcp).mockResolvedValueOnce({ content: [{ id: "1" }] });
    const result = await (handlers as any).drupal_node_list({
      primitiveName: "drupal_node_list",
      input: { instanceId: "site-A" },
      actor: { actorType: "model", source: "agent" },
      mode: "agentic",
    });
    expect(result).toMatchObject({ items: [{ id: "1" }] });
    expect(requireInstanceWriteAuthorityMock).not.toHaveBeenCalled();
  });
});
