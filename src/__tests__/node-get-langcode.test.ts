import { beforeEach, describe, expect, it, vi } from "vitest";

// The node read must hand its caller the node's language. The live
// drupal/mcp_tools `mcp_jsonapi_list_entities` serializer does NOT carry a
// `langcode` key, neither at the top level nor in `fields`; the only language
// value it prints for a node is the computed `path` field item's `langcode`.
// Without a language the content editor's published edit is refused before any
// write ("the actual read did not provide a non-empty nodeLanguage").
vi.mock("../lib/drupal-mcp-client", () => ({ callDrupalMcp: vi.fn() }));

import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "../mcp/handlers";
import { registerDrupalConnector } from "../deps";
import { MODULE_READ_REVISION as READER } from "../integration/module-protected-draft";

const READ = "mcp_jsonapi_list_entities";
const instance = { id: "site", name: "Site", siteUrl: "https://example.test", nangoConnectionId: "site", providerConfigKey: "drupal", createdAt: "", updatedAt: "" };

function deps() {
  registerDrupalConnector({
    decodeCursor: () => 0,
    buildListPage: (items, total) => ({ items, total }),
    dispatchContentEditor: async () => "{}",
    buildNangoBearerHeader: async () => ({ Authorization: "Bearer unit" }),
    listMcpInstances: () => [instance],
    probeMcp: async () => "registered",
    resolveMcpServerUrl: (s) => s,
    isPrivateUrl: () => false,
    isNangoConfigured: () => true,
    getApiStatus: async () => ({ instanceCount: 1, instances: [] }),
    saveInstance: vi.fn(),
    deleteInstance: vi.fn(),
    listInstanceStatuses: async () => [],
    requireInstanceWriteAuthority: async () => {},
  });
}

// The exact item shape the live read answered for a published page (values
// shortened): no `langcode` key anywhere but inside `fields.path`.
function liveItem(fieldsOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    entity_type: "node",
    bundle: "page",
    id: "3",
    uuid: "uuid-3",
    label: "About this demo",
    status: true,
    created: "1794476147",
    changed: "1794476147",
    ...over,
    fields: {
      nid: "3",
      vid: "3",
      revision_timestamp: "1794476147",
      title: "About this demo",
      promote: "0",
      sticky: "0",
      revision_default: "1",
      revision_translation_affected: "1",
      moderation_state: "published",
      path: [{ langcode: "en" }],
      body: "<p>Page body</p>",
      ...fieldsOver,
    },
  };
}

function readAnswers(item: unknown) {
  vi.mocked(callDrupalMcp).mockImplementation(async (_instance, tool) => {
    if (tool === READ) return { items: [item], total: 1 };
    if (tool === READER) throw new Error("reader stops this test");
    throw new Error(`unexpected tool: ${tool}`);
  });
}

async function get(nodeId = "3"): Promise<Record<string, unknown>> {
  const node: unknown = await createDrupalPrimitiveHandlers().drupal_node_get({ input: { instanceId: "site", nodeId } } as never);
  return node as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps();
});

describe("drupal_node_get hands over the node's language", () => {
  it("takes the language of the live read shape from the path item when the read carries no langcode key", async () => {
    readAnswers(liveItem());
    const node = await get();
    expect(node.langcode).toBe("en");
    expect(node.body).toBe("<p>Page body</p>");
  });

  it("keeps a langcode the read itself carries in fields", async () => {
    readAnswers(liveItem({ langcode: "de", path: [{ langcode: "de" }] }));
    expect((await get()).langcode).toBe("de");
  });

  it("keeps a top-level langcode of the read", async () => {
    readAnswers(liveItem({ path: [{ langcode: "fr" }] }, { langcode: "fr" }));
    expect((await get()).langcode).toBe("fr");
  });

  it("never takes a not-specified or not-applicable path language: an alias fallback is not the node's language", async () => {
    for (const code of ["und", "zxx"]) {
      readAnswers(liveItem({ path: [{ langcode: code }] }));
      expect((await get()).langcode).toBeUndefined();
    }
  });

  it("never guesses when path items disagree, carry no language or an unsafe one", async () => {
    for (const path of [
      [{ langcode: "en" }, { langcode: "de" }],
      [],
      [{ alias: "/about" }],
      [{ langcode: "" }],
      [{ langcode: "en us" }],
      [{ langcode: 5 }],
      "en",
    ]) {
      readAnswers(liveItem({ path }));
      expect((await get()).langcode).toBeUndefined();
    }
  });

  it("does not replace a langcode the read carries with the path language", async () => {
    readAnswers(liveItem({ langcode: { value: "de" }, path: [{ langcode: "en" }] }));
    expect((await get()).langcode).not.toBe("en");
  });
});

describe("drupal_node_create_draft_revision on the live read shape", () => {
  it("binds the protected read to the node's language from the read, not to a refusal", async () => {
    readAnswers(liveItem());
    const error: unknown = await createDrupalPrimitiveHandlers()
      .drupal_node_create_draft_revision({
        input: { instanceId: "site", nodeId: "3", fields: { body: "<p>Changed</p>" } },
      } as never)
      .then(() => undefined, (e: unknown) => e);
    const message = error instanceof Error ? error.message : String(error);
    // Named outcome first, so a failure says in a few words which refusal came: the
    // assertion library cuts long strings, and the refusal sentence is long.
    expect(/exact language is absent/.test(message) ? "language refusal" : "no language refusal").toBe("no language refusal");
    // The stub reader throws, so the handler stops at the module's preimage read.
    expect(message).toMatch(/preimage reader is unavailable/);
    const readerCalls = vi.mocked(callDrupalMcp).mock.calls.filter((c) => c[1] === READER);
    expect(readerCalls).toHaveLength(1);
    expect(readerCalls[0][2]).toMatchObject({ nid: 3, language: "en" });
  });

  it("still refuses before any module call when the read gives no usable language", async () => {
    readAnswers(liveItem({ path: [{ langcode: "und" }] }));
    await expect(
      createDrupalPrimitiveHandlers().drupal_node_create_draft_revision({
        input: { instanceId: "site", nodeId: "3", fields: { body: "<p>Changed</p>" } },
      } as never),
    ).rejects.toThrow(/exact language is absent/);
    expect(vi.mocked(callDrupalMcp).mock.calls.filter((c) => c[1] === READER)).toHaveLength(0);
  });
});
