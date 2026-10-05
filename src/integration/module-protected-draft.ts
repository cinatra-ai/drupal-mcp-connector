import { stableStringify, type DrupalRawNode } from "./cms-review-trigger";

export const PROTECTED_DRAFT_CONTRACT = "cinatra.protected-draft/v1";
export const MODULE_READ_REVISION = "cinatra_read_protected_revision";
export const MODULE_WRITE_DRAFT = "cinatra_write_protected_draft";

export type StoredFieldItems = Record<string, Record<string, unknown>[]>;
export type ModuleDraftIdentity = { nid: number; uuid: string; language: string; fields: string[] };
export type ModulePreimage = {
  node_id: number; uuid: string; language: string;
  default_revision_id: number; latest_revision_id: number;
  workflow_fingerprint: string; preimage_fingerprint: string;
  fields: StoredFieldItems;
  available_fields?: string[];
};
export type ModuleDraftPlan = { state: string; preimage: ModulePreimage };
export type ModuleStoredRevision = {
  node_id: number; uuid: string; language: string; revision_id: number;
  default_revision_id: number; is_default_revision: false; is_published: false;
  moderation_state: string; fields: StoredFieldItems;
};

const protectedFields = new Set([
  "id", "nid", "vid", "uuid", "type", "bundle", "langcode", "status", "moderation_state",
  "uid", "created", "changed", "revision_uid", "revision_timestamp",
  "revision_log", "revision_default", "revision_translation_affected",
  "default_langcode", "content_translation_source", "content_translation_outdated",
  "revision_id", "field_moderation_state",
  "__proto__", "constructor", "prototype",
]);
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    ? value as Record<string, unknown> : null;
}
function refusal(reason: string): never {
  throw new Error(`Protected draft unavailable: ${reason}`);
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function fingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function payload(value: unknown): Record<string, unknown> {
  const envelope = object(value);
  const result = object(envelope?.result);
  if (!envelope || envelope.contract !== PROTECTED_DRAFT_CONTRACT || !result) {
    refusal("the supported Cinatra module contract is absent or malformed; update and expose its existing MCP tools.");
  }
  return result;
}
function storedFields(value: unknown, requested: string[]): StoredFieldItems {
  const fields = object(value);
  if (!fields || stableStringify(Object.keys(fields).sort()) !== stableStringify([...requested].sort())) {
    refusal("the exact requested stored field set is unavailable.");
  }
  for (const [name, items] of Object.entries(fields)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || protectedFields.has(name)
      || !Array.isArray(items) || items.some((item) => !object(item))) {
      refusal("stored fields must have canonical names and structured field items.");
    }
  }
  return fields as StoredFieldItems;
}

/** Validate one atomic-module preimage, never independent generic reads. */
export function prepareModuleDraft(value: unknown, expected: ModuleDraftIdentity): ModuleDraftPlan {
  const result = payload(value);
  if (result.node_id !== expected.nid || result.uuid !== expected.uuid || result.language !== expected.language
    || result.is_default_revision !== true || result.is_published !== true
    || result.moderated !== true || result.canonical_moderation_field !== true
    || !positiveInteger(result.default_revision_id) || result.latest_revision_id !== result.default_revision_id
    || !fingerprint(result.workflow_fingerprint) || !fingerprint(result.preimage_fingerprint)) {
    refusal("the exact language-bound published preimage, moderation or revision/configuration binding is not established; a pending draft must be reviewed or discarded first.");
  }
  const states = object(result.draft_states);
  const allowed = result.allowed_draft_states;
  if (!states || !Array.isArray(allowed) || allowed.some((state) => typeof state !== "string")) {
    refusal("authorized non-default draft states are unavailable.");
  }
  const safe = [...new Set(allowed)].filter((id) => {
    const state = object(states[id]);
    return state?.published === false && state.default_revision === false;
  });
  if (safe.length !== 1) refusal("an unambiguous authorized unpublished, non-default draft state is required.");
  return {
    state: safe[0],
    preimage: {
      node_id: expected.nid, uuid: expected.uuid, language: expected.language,
      default_revision_id: result.default_revision_id, latest_revision_id: result.default_revision_id,
      workflow_fingerprint: result.workflow_fingerprint, preimage_fingerprint: result.preimage_fingerprint,
      fields: storedFields(result.fields, expected.fields),
      ...(Array.isArray(result.available_fields) && result.available_fields.every((field) => typeof field === "string" && /^[a-z][a-z0-9_]*$/.test(field) && !protectedFields.has(field))
        ? { available_fields: result.available_fields as string[] } : {}),
    },
  };
}

/** Preserve stored format/summary and never guess an empty field's schema. */
export function structureModuleUpdates(fields: Record<string, unknown>, before: StoredFieldItems): StoredFieldItems {
  const updates: StoredFieldItems = {};
  for (const [name, value] of Object.entries(fields)) {
    if (protectedFields.has(name) || !/^[a-z][a-z0-9_]*$/.test(name) || !Object.hasOwn(before, name)) {
      refusal("requested fields must be canonical editable fields from the stored preimage.");
    }
    if (Array.isArray(value)) {
      if (value.some((item) => !object(item))) refusal("field lists require structured item values.");
      updates[name] = value.map((item) => ({ ...item as Record<string, unknown> }));
    }
    else if (object(value)) {
      updates[name] = [{ ...value as Record<string, unknown> }];
    }
    else {
      const items = before[name];
      if (items.length !== 1 || !Object.hasOwn(items[0], "value") || value === undefined) {
        refusal("a scalar edit cannot guess or replace an empty or multi-valued field; provide structured items.");
      }
      updates[name] = [{ ...items[0], value }];
    }
  }
  return updates;
}

/** A safely identified reported revision is an inspection clue, not success. */
export function reportedModuleRevisionId(value: unknown, expected: Pick<ModuleDraftIdentity, "nid" | "uuid" | "language">): number | undefined {
  const envelope = object(value);
  const result = object(envelope?.result);
  return envelope?.contract === PROTECTED_DRAFT_CONTRACT
    && result?.node_id === expected.nid && result.uuid === expected.uuid
    && result.language === expected.language && positiveInteger(result.revision_id)
    ? result.revision_id : undefined;
}

/** Require exact stored identity/status/fields from writer and separate reader. */
export function verifyModuleRevision(value: unknown, plan: ModuleDraftPlan, expected: ModuleDraftIdentity, revisionId?: number): ModuleStoredRevision {
  const result = payload(value);
  if (result.node_id !== expected.nid || result.uuid !== expected.uuid || result.language !== expected.language
    || !positiveInteger(result.revision_id) || result.revision_id === plan.preimage.default_revision_id
    || (revisionId !== undefined && result.revision_id !== revisionId)
    || result.default_revision_id !== plan.preimage.default_revision_id
    || result.is_default_revision !== false || result.is_published !== false || result.moderation_state !== plan.state) {
    refusal("the exact stored revision is not the verified unpublished, non-default draft.");
  }
  return {
    node_id: expected.nid, uuid: expected.uuid, language: expected.language,
    revision_id: result.revision_id, default_revision_id: plan.preimage.default_revision_id,
    is_default_revision: false, is_published: false, moderation_state: plan.state,
    fields: storedFields(result.fields, expected.fields),
  };
}

/** Same projection for review proposal, its preimage and actual stored result. */
export function moduleRevisionReviewNode(revision: Pick<ModuleStoredRevision, "node_id" | "uuid" | "language" | "fields"> & { is_published: boolean }, structuredFields: readonly string[] = []): DrupalRawNode {
  const node: DrupalRawNode = { id: String(revision.node_id), nid: revision.node_id, uuid: revision.uuid, langcode: revision.language, status: revision.is_published };
  for (const [name, items] of Object.entries(revision.fields)) {
    node[name] = structuredFields.includes(name) ? items : items.length === 0 ? ""
      : items.length === 1 && Object.hasOwn(items[0], "value") ? items[0].value : items;
    if (name === "body" && items.length <= 1) node.summary = items[0]?.summary ?? "";
  }
  return node;
}
