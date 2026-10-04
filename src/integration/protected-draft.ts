/** Protected draft planning from the site's actual moderation metadata.
 * This describes the intended write, not observed persistence. Exact-revision
 * MCP readback is still required before the handler can release that write. */
export type ProtectedDraftPlan = {
  nodeId: number;
  nodeUuid: string;
  bundle: string;
  moderationState: string;
  updates: Record<string, unknown>;
  proposed: Record<string, unknown>;
};

const PROTECTED_FIELDS = new Set([
  "status", "moderation_state", "id", "nid", "uuid", "vid", "type", "bundle",
  "revision_default", "revision_id", "revision_translation_affected",
  "__proto__", "constructor", "prototype",
]);
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function own(map: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function nodePublishedStatus(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1" || value === "published") return true;
  if (value === false || value === 0 || value === "0" || value === "unpublished" || value === "draft") return false;
  return null;
}
function refuse(reason: string): never {
  throw new Error(`Protected draft unavailable: ${reason}. Check Content Moderation, its workflow and your transition permission; alternatively choose a separate new page explicitly. No Drupal content was written.`);
}
export function planProtectedDraft(
  nid: number,
  fields: Record<string, unknown>,
  current: unknown,
  moderation: unknown,
  definition: unknown,
): ProtectedDraftPlan {
  if (!Number.isSafeInteger(nid) || nid <= 0) refuse("invalid node identity");
  if (Object.keys(fields).length === 0) refuse("no changed fields were supplied");
  if (Object.keys(fields).some((key) => PROTECTED_FIELDS.has(key))) {
    refuse("caller fields cannot override protected publication or revision identity");
  }
  const node = object(current);
  if (!node || String(node.id) !== String(nid) || node.nid !== nid ||
      !text(node.uuid) || !text(node.bundle) || nodePublishedStatus(node.status) !== true) {
    refuse("the requested node's published default identity is not established");
  }
  const state = object(moderation);
  const active = object(state?.current_state);
  if (!state || state.entity_type !== "node" || state.entity_id !== nid ||
      state.bundle !== node.bundle || !text(state.workflow_id) || !active ||
      !text(active.id) || active.published !== true || active.default_revision !== true ||
      !Array.isArray(state.available_transitions)) {
    refuse("moderation metadata does not establish this node's published default workflow");
  }
  const workflow = object(definition);
  const entityTypes = object(workflow?.entity_types);
  const bundles = entityTypes?.node;
  const states = object(workflow?.states);
  const transitions = object(workflow?.transitions);
  if (!workflow || workflow.id !== state.workflow_id || !Array.isArray(bundles) ||
      !bundles.includes(node.bundle) || !states || !transitions) {
    refuse("the workflow is not bound to this node's bundle");
  }
  const from = object(own(states, active.id));
  if (!from || from.id !== active.id || from.published !== true || from.default_revision !== true) {
    refuse("current moderation state disagrees with the workflow definition");
  }
  const safeTargets = new Set<string>();
  for (const available of state.available_transitions) {
    const permitted = object(available);
    if (!permitted || !text(permitted.id) || !text(permitted.to_state)) {
      refuse("available moderation transition is malformed");
    }
    const transition = object(own(transitions, permitted.id));
    if (!transition || transition.id !== permitted.id || transition.to !== permitted.to_state ||
        !Array.isArray(transition.from) || !transition.from.includes(active.id)) {
      refuse("per-user moderation transition disagrees with the workflow definition");
    }
    const target = object(own(states, permitted.to_state));
    if (!target || target.id !== permitted.to_state || typeof target.published !== "boolean" ||
        typeof target.default_revision !== "boolean") {
      refuse("target moderation state flags are missing or malformed");
    }
    if (target.published === false && target.default_revision === false) safeTargets.add(permitted.to_state);
  }
  if (safeTargets.size === 0) refuse("no authorized non-published, non-default moderation transition exists");
  if (safeTargets.size !== 1) refuse("authorized protected moderation destinations are ambiguous");
  const moderationState = [...safeTargets][0];
  return {
    nodeId: nid, nodeUuid: node.uuid, bundle: node.bundle, moderationState,
    // ContentService accepts moderation_state; Drupal's moderation presave hook
    // creates the non-default revision and derives its publication status.
    // A literal status:false would be a dangerous live-update fallback.
    updates: { ...fields, moderation_state: moderationState },
    proposed: { ...fields, status: false },
  };
}
