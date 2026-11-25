// cinatra#3745 (owner decision 1234 A): a page edit is read and written by
// flow steps without a model, and each write happens only if the page is
// unchanged since the read the review was based on. `drupal_node_read_for_edit`
// returns the Cinatra module's binding of that read; the write tools pass it
// to the module's own tools, which compare it again under the node lock. This
// file holds the binding's shape check, the JSON text arguments and the
// mapping of the module's refusals. PURE: no site calls.

import { PROTECTED_DRAFT_CONTRACT } from "./module-protected-draft";

export const MODULE_WRITE_UNPUBLISHED = "cinatra_write_unpublished";
export const MODULE_PUBLISH_UNPUBLISHED = "cinatra_publish_unpublished";

/** The binding of one module read (`cinatra_read_protected_revision` without
 * `revision_id`), as `drupal_node_read_for_edit` returns it. The member names
 * are the module's own input names, so a flow passes the object on unchanged. */
export type EditBinding = {
  nid: number;
  language: string;
  published: boolean;
  expected_default_revision_id: number;
  expected_latest_revision_id: number;
  expected_changed: number;
  workflow_fingerprint: string;
  preimage_fingerprint: string;
};

const BINDING_KEYS = [
  "expected_changed", "expected_default_revision_id", "expected_latest_revision_id",
  "language", "nid", "preimage_fingerprint", "published", "workflow_fingerprint",
] as const;

/** A refusal with a stable code a flow can branch on. The message is
 * `<code>: <fixed text>` and never repeats page content or site text. */
export class DrupalEditRefusal extends Error {
  readonly code: string;
  constructor(code: string, text: string) {
    super(`${code}: ${text}`);
    this.name = "DrupalEditRefusal";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Fixed refusal texts
// ---------------------------------------------------------------------------

export const REFUSAL = {
  invalidBinding: () => new DrupalEditRefusal("invalid_binding",
    "expectedBinding must be the binding object from drupal_node_read_for_edit, with every member present and well formed and no other member. Nothing was written."),
  bindingMismatch: () => new DrupalEditRefusal("invalid_binding",
    "expectedBinding names another page or language than this call. Nothing was written."),
  publishedBinding: () => new DrupalEditRefusal("wrong_page_state",
    "The binding is for a published page; save the change as a draft with drupal_node_create_draft_revision. Nothing was written."),
  unpublishedBinding: () => new DrupalEditRefusal("wrong_page_state",
    "The binding is for an unpublished page; save the change with drupal_node_update, or publish it with drupal_node_publish. Nothing was written."),
  capabilityMissing: (tool: string) => new DrupalEditRefusal("module_capability_missing",
    `The site does not offer ${tool}. A write bound to an earlier read needs the Cinatra Drupal module version with ${MODULE_WRITE_UNPUBLISHED} and ${MODULE_PUBLISH_UNPUBLISHED}, exposed through the site's MCP profile, and the account's permission to use it. Nothing was written.`),
  capabilityUnconfirmed: () => new DrupalEditRefusal("module_capability_missing",
    "The site's tool list could not be read, so the Cinatra Drupal module tools for a write bound to an earlier read could not be confirmed. Nothing was written."),
  readCapabilityMissing: () => new DrupalEditRefusal("module_capability_missing",
    `The site's Cinatra Drupal module did not return a complete binding (revisions, changed time, workflow and content fingerprints). The read for an edit needs the module version with ${MODULE_WRITE_UNPUBLISHED} and ${MODULE_PUBLISH_UNPUBLISHED}.`),
  readChanged: () => new DrupalEditRefusal("node_changed",
    "The page changed between the module reads; read it again."),
  nodeChanged: () => new DrupalEditRefusal("node_changed",
    "The page changed after the read that the review was based on. Nothing was written. Read the page again and review the change again."),
  pendingRevision: () => new DrupalEditRefusal("pending_revision",
    "The page has a newer revision that waits for review. Nothing was written. Review or discard that revision first."),
  permissionDenied: () => new DrupalEditRefusal("permission_denied",
    "The site does not permit this edit for the connected account. Nothing was written."),
  invalidInput: () => new DrupalEditRefusal("invalid_input",
    "The site refused the field values or the request. Nothing was written."),
  structureUnavailable: () => new DrupalEditRefusal("read_unavailable",
    "The stored structure of the requested fields could not be read through the Cinatra module reader. Nothing was written."),
  pageUnreadable: () => new DrupalEditRefusal("read_unavailable",
    "The current page could not be read through the site's MCP tools. Nothing was written."),
  noFields: () => new DrupalEditRefusal("invalid_input",
    "No non-empty field values were given. Nothing was written."),
  systemField: () => new DrupalEditRefusal("invalid_input",
    "Identity and system fields cannot be edited. Nothing was written."),
  instanceNotFound: () => new DrupalEditRefusal("invalid_input",
    "The Drupal instance was not found. Nothing was written."),
  authorityDenied: () => new DrupalEditRefusal("permission_denied",
    "The person may not write to this Drupal instance. Nothing was written."),
  draftNotPossible: () => new DrupalEditRefusal("refused",
    "The site's protected draft read does not allow a draft of this page (for example it is not moderated or no single unpublished draft state is permitted). Nothing was written."),
  updateDoesNotPublish: () => new DrupalEditRefusal("invalid_input",
    "drupal_node_update does not publish. Publish with drupal_node_publish; with expectedBinding and fields it writes and publishes in one save. Nothing was written."),
  refused: () => new DrupalEditRefusal("refused",
    "The site refused the write. Read the page again before retrying."),
  writeUnverified: () => new DrupalEditRefusal("write_unverified",
    "The write was sent but its result could not be verified; a change may have been saved. Inspect the page before retrying."),
};

// ---------------------------------------------------------------------------
// The binding's shape check (the module compares the values)
// ---------------------------------------------------------------------------

const LANGCODE = /^[a-zA-Z0-9_-]+$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Check the binding's shape only: every member present with its type, no
 * other member, and the same page and language as the call. The values are
 * compared by the module under the node lock, never here. */
export function checkEditBinding(value: unknown, call: { nid: number; language?: string }): EditBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw REFUSAL.invalidBinding();
  const b = value as Record<string, unknown>;
  const keys = Object.keys(b).sort();
  if (keys.length !== BINDING_KEYS.length || keys.some((key, i) => key !== BINDING_KEYS[i])
    || !positive(b.nid) || typeof b.language !== "string" || !LANGCODE.test(b.language)
    || typeof b.published !== "boolean"
    || !positive(b.expected_default_revision_id) || !positive(b.expected_latest_revision_id)
    || typeof b.expected_changed !== "number" || !Number.isSafeInteger(b.expected_changed) || b.expected_changed < 0
    || typeof b.workflow_fingerprint !== "string" || !FINGERPRINT.test(b.workflow_fingerprint)
    || typeof b.preimage_fingerprint !== "string" || !FINGERPRINT.test(b.preimage_fingerprint)) {
    throw REFUSAL.invalidBinding();
  }
  if (b.nid !== call.nid || (call.language !== undefined && b.language !== call.language)) throw REFUSAL.bindingMismatch();
  return {
    nid: b.nid, language: b.language, published: b.published,
    expected_default_revision_id: b.expected_default_revision_id,
    expected_latest_revision_id: b.expected_latest_revision_id,
    expected_changed: b.expected_changed,
    workflow_fingerprint: b.workflow_fingerprint, preimage_fingerprint: b.preimage_fingerprint,
  };
}

/** The binding's members as the module's tools take them (no `published`). */
export function moduleBindingArgs(binding: EditBinding): Record<string, unknown> {
  return {
    nid: binding.nid, language: binding.language,
    expected_default_revision_id: binding.expected_default_revision_id,
    expected_latest_revision_id: binding.expected_latest_revision_id,
    expected_changed: binding.expected_changed,
    workflow_fingerprint: binding.workflow_fingerprint,
    preimage_fingerprint: binding.preimage_fingerprint,
  };
}

// ---------------------------------------------------------------------------
// JSON text arguments
// ---------------------------------------------------------------------------

// A flow step without a model sends rendered template text, so an object
// argument may arrive as the text of a JSON object instead. The same bound and
// refusals as the WordPress connector's `argsJson`: 256 KiB counted in UTF-8
// bytes (the host's limit for one action), a plain object, fixed messages that
// never repeat the text.
export const JSON_ARGUMENT_MAX_BYTES = 256 * 1024;

/** Resolve one object argument given as `objectName` or as `textName`, never
 * both. Returns undefined when neither is given. */
export function objectOrJsonText(
  objectValue: Record<string, unknown> | undefined,
  textValue: string | undefined,
  names: { object: string; text: string; both: string },
): Record<string, unknown> | undefined {
  if (objectValue !== undefined && textValue !== undefined) throw new Error(names.both);
  if (textValue === undefined) return objectValue;
  // A string has at least as many UTF-8 bytes as UTF-16 code units, so a long
  // string is refused before it is encoded.
  if (textValue.length > JSON_ARGUMENT_MAX_BYTES || new TextEncoder().encode(textValue).length > JSON_ARGUMENT_MAX_BYTES) {
    throw new Error(`${names.text} is larger than ${JSON_ARGUMENT_MAX_BYTES} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    throw new Error(`${names.text} must be the text of a JSON object.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${names.text} must be the text of a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export const FIELDS_ARGUMENT = { object: "fields", text: "fieldsJson", both: "Give the field updates as fields or as fieldsJson, not both." };
export const BINDING_ARGUMENT = { object: "expectedBinding", text: "expectedBindingJson", both: "Give the binding as expectedBinding or as expectedBindingJson, not both." };

// ---------------------------------------------------------------------------
// The module's refusals
// ---------------------------------------------------------------------------

// The fixed `ProtectedDraftRefusal` texts of the Cinatra module (and its tool
// base's access failure). A refusal is thrown inside the module's transaction,
// so a refused write stored nothing. Any other text maps to `refused`.
const NODE_CHANGED = new Set([
  "The page revision changed; read it again before editing.",
  "The workflow configuration changed; read it again before editing.",
  "The page values changed; read them again before editing.",
  "The live page values changed; read them again before editing.",
  "The page was saved after it was read; read it again before editing.",
  "The page workflow changed; read it again before editing.",
  "The live preimage changed during the save; the edit was rolled back.",
  "The page workflow changed during the save; the write was rolled back.",
  "The node storage mapping changed; read the page again.",
  "The workflow or field configuration changed before saving.",
  // The binding said unpublished (checked before the call), so the page was
  // published after the read.
  "This page is published; edit it through the protected draft instead.",
  // The binding said published (checked before the call), so the page was
  // unpublished after the read.
  "The protected edit must start from a published default revision.",
]);
// A pending revision: a change since the read when the read had none.
const PENDING = new Set([
  "A newer revision than the current one exists; review it first.",
  "A draft already waits for review; review or discard it first.",
]);
const PERMISSION = new Set([
  "Editing this page is not permitted.",
  "Publishing this page is not permitted.",
  "Changing the workflow state of this page is not permitted.",
  "A requested field cannot be edited in this translation.",
  "The page edit or draft transition is not permitted.",
  "The existing MCP content integration and its read/write permissions are required.",
]);
const INVALID_INPUT = new Set([
  "A complete language-bound revision, changed time, workflow and content binding is required.",
  "A complete language-bound revision and workflow preimage is required.",
  "A page, its exact language and canonical field names are required.",
  "Canonical field names are required.",
  "Each requested field must appear once.",
  "A requested field does not exist on this page.",
  "Updates must use editable revisioned fields and structured item values.",
  "An unpublished write needs field values or the publish step.",
  "The field values are invalid; nothing was written.",
  "The draft field values are invalid; the live page was not edited.",
  "An explicit permitted text format is required.",
  "The proposed text format is not permitted.",
  "The stored value differs from the reviewed value; nothing was written.",
  "Shared stored fields must belong to the requested edit scope.",
  "A shared stored field must have one value across all page translations.",
]);
// The module's own "inspect before retrying" failures.
const UNVERIFIED = new Set([
  "The page revision could not be verified; inspect it before retrying.",
  "The protected root transaction is no longer active; inspect the page before retrying.",
  "The protected transaction did not finish its root commit.",
]);

/** Map a failed module write call to a stable refusal. Returns null when the
 * error is not the module's failure answer for `tool` (for example a transport
 * failure): the caller then cannot prove that nothing was written. */
export function mapModuleWriteFailure(error: unknown, tool: string, binding: EditBinding): DrupalEditRefusal | null {
  const prefix = `Drupal ${tool} returned failure: `;
  const message = error instanceof Error ? error.message : "";
  if (!message.startsWith(prefix)) return null;
  const text = message.slice(prefix.length);
  if (NODE_CHANGED.has(text)) return REFUSAL.nodeChanged();
  if (PENDING.has(text)) {
    return binding.expected_latest_revision_id === binding.expected_default_revision_id
      ? REFUSAL.nodeChanged() : REFUSAL.pendingRevision();
  }
  if (PERMISSION.has(text)) return REFUSAL.permissionDenied();
  if (INVALID_INPUT.has(text)) return REFUSAL.invalidInput();
  if (UNVERIFIED.has(text)) return REFUSAL.writeUnverified();
  return REFUSAL.refused();
}

// ---------------------------------------------------------------------------
// The module's answer to a bound unpublished write
// ---------------------------------------------------------------------------

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The stored result of `cinatra_write_unpublished` / `cinatra_publish_unpublished`:
 * the same page and language, a new default revision, the requested published
 * status, a changed time and exactly the requested stored fields (none for a
 * publish only, which PHP sends as an empty list). Anything else is reported
 * as unverified: the write was sent, so a change may have been saved. */
export function verifyUnpublishedWrite(value: unknown, binding: EditBinding, requested: string[], publish: boolean): {
  revision_id: number; published: boolean; changed: number; fields: Record<string, Record<string, unknown>[]>;
} {
  const envelope = plainObject(value);
  const result = plainObject(envelope?.result);
  if (!envelope || envelope.contract !== PROTECTED_DRAFT_CONTRACT || !result
    || result.node_id !== binding.nid || result.language !== binding.language
    || !positive(result.revision_id) || result.revision_id === binding.expected_default_revision_id
    || result.is_default_revision !== true || result.is_published !== publish
    || typeof result.changed !== "number" || !Number.isSafeInteger(result.changed) || result.changed < 0) {
    throw REFUSAL.writeUnverified();
  }
  const raw = result.fields;
  const fields = Array.isArray(raw) && raw.length === 0 ? {} : plainObject(raw);
  if (!fields || JSON.stringify(Object.keys(fields).sort()) !== JSON.stringify([...requested].sort())
    || Object.values(fields).some((items) => !Array.isArray(items) || items.some((item) => !plainObject(item)))) {
    throw REFUSAL.writeUnverified();
  }
  return { revision_id: result.revision_id, published: publish, changed: result.changed, fields: fields as Record<string, Record<string, unknown>[]> };
}

/** On a bound protected draft, the connector's own module read answers a page
 * state the draft cannot start from with a coded refusal decided against the
 * binding: an unpublished page, or a pending revision (one created after the
 * read is a change; one the read already had is `pending_revision`). Returns
 * null when the read shows neither. */
export function boundDraftReadRefusal(value: unknown, binding: EditBinding): DrupalEditRefusal | null {
  const result = plainObject(plainObject(value)?.result);
  if (!result) return null;
  if (result.is_published === false) return REFUSAL.nodeChanged();
  if (positive(result.latest_revision_id) && positive(result.default_revision_id)
    && result.latest_revision_id !== result.default_revision_id) {
    return binding.expected_latest_revision_id === binding.expected_default_revision_id
      ? REFUSAL.nodeChanged() : REFUSAL.pendingRevision();
  }
  return null;
}
