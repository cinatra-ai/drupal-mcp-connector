import { beforeEach, describe, expect, it, vi } from "vitest";

// A language read only from the computed `path` item is a CANDIDATE, not proof:
// when the path field is untranslatable, Drupal answers the default translation's
// language there even if another translation was serialized. A protected draft
// may use such a language only when the Cinatra module's preimage reports that
// the node has exactly that one translation; otherwise it refuses before any write.
vi.mock("../lib/drupal-mcp-client", () => ({ callDrupalMcp: vi.fn() }));

import { callDrupalMcp } from "../lib/drupal-mcp-client";
import { createDrupalPrimitiveHandlers } from "../mcp/handlers";
import { registerDrupalConnector } from "../deps";
import {
  MODULE_READ_REVISION as READER,
  MODULE_WRITE_DRAFT as WRITER,
  PROTECTED_DRAFT_CONTRACT,
  type StoredFieldItems,
} from "../integration/module-protected-draft";

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

// The live read shape of a published page (values shortened): no `langcode` key,
// the only language value is the computed path item.
function item(fieldsOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    entity_type: "node", bundle: "page", id: "3", uuid: "uuid-3", label: "About", status: true, ...over,
    fields: { nid: "3", vid: "3", title: "About", moderation_state: "published", path: [{ langcode: "en" }], body: "<p>Page body</p>", ...fieldsOver },
  };
}

const before: StoredFieldItems = { body: [{ value: "<p>Page body</p>", format: "basic_html" }] };
const envelope = (result: unknown) => ({ contract: PROTECTED_DRAFT_CONTRACT, result });

// A complete module road; `translations` is the preimage's translation_languages
// (undefined: the module does not report it).
function route(node: unknown, translations?: unknown) {
  let saved = structuredClone(before);
  vi.mocked(callDrupalMcp).mockImplementation(async (_instance, tool, raw) => {
    const args = raw as Record<string, unknown>;
    const language = args.language;
    const stored = { node_id: 3, uuid: "uuid-3", language, revision_id: 11, default_revision_id: 10, is_default_revision: false, is_published: false, moderation_state: "working" };
    if (tool === READ) return { items: [node] };
    if (tool === READER) {
      const names = args.fields as string[];
      if (args.revision_id !== undefined) return envelope({ ...stored, fields: Object.fromEntries(names.map((k) => [k, saved[k]])) });
      return envelope({
        node_id: 3, uuid: "uuid-3", language, default_revision_id: 10, latest_revision_id: 10, is_default_revision: true, is_published: true,
        moderated: true, canonical_moderation_field: true, workflow_fingerprint: "a".repeat(64), preimage_fingerprint: "c".repeat(64),
        draft_states: { working: { published: false, default_revision: false } }, allowed_draft_states: ["working"],
        available_fields: ["body"], fields: Object.fromEntries(names.map((k) => [k, before[k]])),
        ...(translations === undefined ? {} : { translation_languages: translations }),
      });
    }
    if (tool === WRITER) {
      const updates = args.updates as StoredFieldItems;
      saved = { ...saved, ...updates };
      return envelope({ ...stored, fields: Object.fromEntries(Object.keys(updates).map((k) => [k, saved[k]])) });
    }
    throw new Error(`unexpected tool: ${tool}`);
  });
}

const writes = () => vi.mocked(callDrupalMcp).mock.calls.filter((c) => c[1] === WRITER);
const draft = (language?: string) =>
  createDrupalPrimitiveHandlers().drupal_node_create_draft_revision({
    input: { instanceId: "site", nodeId: "3", fields: { body: "<p>Changed</p>" }, ...(language ? { language } : {}) },
  } as never);
async function get(node: unknown): Promise<Record<string, unknown>> {
  route(node);
  const read: unknown = await createDrupalPrimitiveHandlers().drupal_node_get({ input: { instanceId: "site", nodeId: "3" } } as never);
  return read as Record<string, unknown>;
}
/** The refusal in a short value: the assertion library cuts long sentences. */
async function outcome(language?: string): Promise<string> {
  try {
    await draft(language);
    return "written";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /read only from its path item/.test(message) ? "path language refused" : `other refusal: ${message.slice(0, 60)}`;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  deps();
});

describe("a path-only language is bound to the node's translations before a protected draft", () => {
  it("refuses a path-only language when the module does not report the node's translations", async () => {
    route(item());
    expect(await outcome()).toBe("path language refused");
    expect(writes()).toHaveLength(0);
  });

  it("refuses a path-only language when the node has another translation (an untranslatable path names the default)", async () => {
    route(item(), ["en", "fr"]);
    expect(await outcome()).toBe("path language refused");
    expect(writes()).toHaveLength(0);
  });

  it("refuses the agent road too: an explicit language equal to the path-only language needs the same binding", async () => {
    route(item(), ["en", "fr"]);
    expect(await outcome("en")).toBe("path language refused");
    expect(writes()).toHaveLength(0);
  });

  it("refuses a path-only language that the module's single translation does not equal", async () => {
    route(item(), ["fr"]);
    expect(await outcome()).toBe("path language refused");
    expect(writes()).toHaveLength(0);
  });

  it("refuses when the module reports translations in an unreadable shape", async () => {
    for (const shape of ["en", [], ["en", "en"], [5], [""], ["en us"], null, { en: true }]) {
      vi.clearAllMocks();
      route(item(), shape);
      expect(await outcome()).toBe("path language refused");
      expect(writes()).toHaveLength(0);
    }
  });

  it("treats a null own langcode as absent: the path candidate still needs the binding", async () => {
    route(item({ langcode: null }), ["en", "fr"]);
    expect(await outcome()).toBe("path language refused");
    expect(writes()).toHaveLength(0);
  });

  it("writes once with the path language when the module reports exactly that one translation (the live single-language page)", async () => {
    route(item(), ["en"]);
    expect(await outcome()).toBe("written");
    expect(writes()).toHaveLength(1);
    expect(writes()[0][2]).toMatchObject({ nid: 3, language: "en" });
  });

  it("keeps the old road for a langcode the read itself carries (no path binding needed)", async () => {
    route(item({ langcode: "en" }));
    expect(await outcome()).toBe("written");
    expect(writes()[0][2]).toMatchObject({ language: "en" });
  });

  it("keeps the old road for an explicit language other than the path candidate (the module checks that translation)", async () => {
    route(item(), ["en", "fr"]);
    expect(await outcome("fr")).toBe("written");
    expect(writes()[0][2]).toMatchObject({ language: "fr" });
  });
});

describe("the read's language value on further shapes", () => {
  it("never takes a case-varied neutral path code", async () => {
    for (const code of ["UND", "Zxx"]) {
      expect((await get(item({ path: [{ langcode: code }] }))).langcode).toBeUndefined();
    }
  });

  it("takes one code that several path items share", async () => {
    expect((await get(item({ path: [{ langcode: "en" }, { langcode: "en", alias: "/about" }] }))).langcode).toBe("en");
  });

  it("gives no language for a single-object path, null items or a primitive item", async () => {
    for (const path of [{ langcode: "en" }, [null], ["en"], [{ langcode: null }]]) {
      expect((await get(item({ path }))).langcode).toBeUndefined();
    }
  });

  it("lets a fields langcode win over a different top-level one, and refuses an unsafe top-level one", async () => {
    expect((await get(item({ langcode: "de" }, { langcode: "fr" }))).langcode).toBe("de");
    expect((await get(item({ path: [{ langcode: "en" }] }, { langcode: 5 }))).langcode).toBeUndefined();
  });
});
