import { describe, it, expect, vi } from "vitest";

import {
  DRUPAL_NODE_TYPE_ID,
  DRUPAL_CONNECTOR_ID,
  buildDrupalPointerActor,
  buildDrupalNodePointerData,
  drupalNodeReferenceState,
  drupalNodeExternalId,
  writeDrupalNodePointerWith,
} from "../integration/pointer-writer-core";

describe("drupalNodeReferenceState", () => {
  it("maps probe outcomes to reference states (present→linked, modified→stale, absent→dangling)", () => {
    expect(drupalNodeReferenceState("present")).toBe("linked");
    expect(drupalNodeReferenceState("modified")).toBe("stale");
    expect(drupalNodeReferenceState("absent")).toBe("dangling");
  });
});

describe("drupalNodeExternalId", () => {
  it("composes the site-scoped identity <instanceId>:<nodeId>", () => {
    expect(drupalNodeExternalId("site-1", 42)).toBe("site-1:42");
    expect(drupalNodeExternalId("site-1", "42")).toBe("site-1:42");
  });

  it("rejects an empty part or a colon-bearing instanceId (keeps the composite reversible)", () => {
    expect(() => drupalNodeExternalId("", 42)).toThrow();
    expect(() => drupalNodeExternalId("site-1", "")).toThrow();
    expect(() => drupalNodeExternalId("site:evil", 42)).toThrow();
  });
});

describe("buildDrupalNodePointerData", () => {
  it("builds the connectorRef external-pointer envelope, defaulting to linked", () => {
    const data = buildDrupalNodePointerData({
      instanceId: "site-1",
      nodeId: 42,
      url: "https://drupal.example.com/node/42",
      title: "Hello",
      excerpt: "Intro",
      remoteVersion: "1721260800",
      verifiedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(data.artifactType).toBe("connector-ref");
    expect(data.originKind).toBe("external_link");
    expect(data.mime).toBe("text/html");
    expect(data.connectorRef).toMatchObject({
      url: "https://drupal.example.com/node/42",
      connectorId: DRUPAL_CONNECTOR_ID,
      externalId: "site-1:42",
      resolvedMimeType: "text/html",
      state: "linked",
      remoteVersion: "1721260800",
      lastVerifiedAt: "2026-07-18T00:00:00.000Z",
    });
  });

  it("carries the caller-supplied reference state (stale / dangling on re-sync)", () => {
    expect(
      buildDrupalNodePointerData({
        instanceId: "site-1",
        nodeId: 7,
        url: "https://drupal.example.com/node/7",
        state: "stale",
      }).connectorRef.state,
    ).toBe("stale");
  });

  it("omits absent optional fields rather than writing undefined/null", () => {
    const data = buildDrupalNodePointerData({
      instanceId: "site-1",
      nodeId: 7,
      url: "https://drupal.example.com/node/7",
    });
    expect("title" in data).toBe(false);
    expect("remoteVersion" in data.connectorRef).toBe(false);
    expect("lastVerifiedAt" in data.connectorRef).toBe(false);
  });

  it("fail-closes on a non-http(s) or malformed url (never persists an unopenable href)", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "/relative", "not a url"]) {
      expect(() =>
        buildDrupalNodePointerData({ instanceId: "site-1", nodeId: 1, url }),
      ).toThrow();
    }
  });
});

describe("buildDrupalPointerActor", () => {
  it("stamps the member role floor + the org (both orgId and organizationId)", () => {
    const actor = buildDrupalPointerActor({ orgId: "org-1", userId: "user-1" });
    expect(actor).toMatchObject({
      actorType: "model",
      source: "agent",
      roles: ["member"],
      orgId: "org-1",
      organizationId: "org-1",
      userId: "user-1",
    });
  });

  it("omits userId when the trigger is not user-attributed", () => {
    const actor = buildDrupalPointerActor({ orgId: "org-1", userId: null });
    expect("userId" in actor).toBe(false);
  });
});

describe("writeDrupalNodePointerWith", () => {
  it("upserts the pointer through objects_save with the host drupal:node typeHint", async () => {
    const saveObject = vi.fn().mockResolvedValue({
      objectId: "obj-1",
      type: DRUPAL_NODE_TYPE_ID,
      isNew: true,
      wasMerged: false,
      confidence: 1,
      changeSetId: "cs-1",
    });
    const provider = { saveObject } as unknown as Parameters<typeof writeDrupalNodePointerWith>[0];
    const actor = buildDrupalPointerActor({ orgId: "org-1" });

    const result = await writeDrupalNodePointerWith(
      provider,
      { instanceId: "site-1", nodeId: 42, url: "https://drupal.example.com/node/42", title: "Hello" },
      actor,
    );

    expect(result).toEqual({ objectId: "obj-1", isNew: true });
    expect(saveObject).toHaveBeenCalledTimes(1);
    const call = saveObject.mock.calls[0][0];
    expect(call.typeHint).toBe(DRUPAL_NODE_TYPE_ID);
    expect(call.mode).toBe("agentic");
    expect(call.actor).toBe(actor);
    expect(call.rawData.connectorRef.externalId).toBe("site-1:42");
    expect(call.rawData.connectorRef.state).toBe("linked");
  });
});
