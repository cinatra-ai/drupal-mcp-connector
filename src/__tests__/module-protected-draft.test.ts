import { describe, expect, it } from "vitest";
import { prepareModuleDraft, verifyModuleRevision, structureModuleUpdates } from "../integration/module-protected-draft";
const envelope = (result: unknown) => ({ contract: "cinatra.protected-draft/v1", result });
const fields = { title: [{ value: "Live" }], body: [{ value: "Live body", format: "basic_html", summary: "Keep summary" }] };
const before = { node_id: 7, uuid: "uuid-7", language: "de", default_revision_id: 10, latest_revision_id: 10, is_default_revision: true, is_published: true, moderated: true, canonical_moderation_field: true, workflow_fingerprint: "a".repeat(64), preimage_fingerprint: "c".repeat(64), draft_states: { working: { published: false, default_revision: false } }, allowed_draft_states: ["working"], fields };
const expected = { nid: 7, uuid: "uuid-7", language: "de", fields: ["title", "body"] };
const saved = { node_id: 7, uuid: "uuid-7", language: "de", revision_id: 11, default_revision_id: 10, is_default_revision: false, is_published: false, moderation_state: "working", fields: { title: [{ value: "Stored" }], body: [{ value: "Stored body", format: "basic_html", summary: "Keep summary" }] } };
describe("existing-module protected draft contract", () => {
 it("uses the complete language-bound preimage, not independent generic workflow reads", () => {
  const plan = prepareModuleDraft(envelope(before), expected);
  expect(plan.state).toBe("working"); expect(plan.preimage.default_revision_id).toBe(10);
 });
 it.each([
  ["missing module contract", { contract: "other", result: before }],
  ["custom moderation alias", envelope({ ...before, canonical_moderation_field: false })],
  ["unmoderated", envelope({ ...before, moderated: false })],
  ["pending draft", envelope({ ...before, latest_revision_id: 11 })],
  ["denied or absent preimage", envelope(null)],
  ["wrong language", envelope({ ...before, language: "en" })],
  ["wrong uuid", envelope({ ...before, uuid: "another" })],
  ["missing workflow fingerprint", envelope({ ...before, workflow_fingerprint: "" })],
  ["missing content fingerprint", envelope({ ...before, preimage_fingerprint: "" })],
  ["missing draft state", envelope({ ...before, draft_states: {} })],
  ["default-like state", envelope({ ...before, draft_states: { working: { published: false, default_revision: true } } })],
  ["published state", envelope({ ...before, draft_states: { working: { published: true, default_revision: false } } })],
  ["missing stored field", envelope({ ...before, fields: { title: fields.title } })],
 ])("refuses %s before a module write can be built", (_reason, value) => {
  expect(() => prepareModuleDraft(value, expected)).toThrow(/protected/i);
 });
 it("preserves format and summary for a scalar body edit", () => {
  expect(structureModuleUpdates({ body: "Requested" }, fields)).toEqual({ body: [{ value: "Requested", format: "basic_html", summary: "Keep summary" }] });
 });
 it("keeps explicit empty stored item lists and structured multi-items", () => {
  expect(structureModuleUpdates({ body: [] }, fields)).toEqual({ body: [] });
  expect(structureModuleUpdates({ body: [{ value: "A", format: "basic_html" }, { value: "B", format: "basic_html" }] }, fields).body).toHaveLength(2);
 });
 it("does not guess a format or wipe multi-valued fields for scalar input", () => {
  expect(() => structureModuleUpdates({ body: "New" }, { body: [] })).toThrow();
  expect(() => structureModuleUpdates({ body: "New" }, { body: [...fields.body, ...fields.body] })).toThrow();
 });
 it("returns actual stored values and metadata, rather than request echoes", () => {
  const plan = prepareModuleDraft(envelope(before), expected);
  const result = verifyModuleRevision(envelope(saved), plan, expected, 11);
  expect(result.fields.body[0]).toEqual({ value: "Stored body", format: "basic_html", summary: "Keep summary" });
 });
 it.each([
  ["node_id", 8], ["uuid", "wrong"], ["language", "en"], ["revision_id", 12],
  ["default_revision_id", 11], ["is_default_revision", true], ["is_published", true],
  ["moderation_state", "live"], ["fields", { title: [{ value: "Echo" }] }],
 ])("refuses exact stored-revision mismatch %s", (key, value) => {
  const plan = prepareModuleDraft(envelope(before), expected);
  expect(() => verifyModuleRevision(envelope({ ...saved, [key]: value }), plan, expected, 11)).toThrow();
 });
});
