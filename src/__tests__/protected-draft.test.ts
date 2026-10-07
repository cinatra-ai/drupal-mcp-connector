import { describe, expect, it } from "vitest";
import { planProtectedDraft } from "../integration/protected-draft";

const node = { id: "7", nid: 7, uuid: "node-uuid", bundle: "article", status: true };
const state = {
  entity_type: "node", entity_id: 7, bundle: "article", workflow_id: "editorial",
  current_state: { id: "live", published: true, default_revision: true },
  available_transitions: [{ id: "revise", to_state: "working" }],
};
const workflow = {
  id: "editorial", entity_types: { node: ["article"] },
  states: {
    live: { id: "live", published: true, default_revision: true },
    working: { id: "working", published: false, default_revision: false },
  },
  transitions: { revise: { id: "revise", from: ["live"], to: "working" } },
};
const plan = (n: unknown = node, s: unknown = state, w: unknown = workflow) =>
  planProtectedDraft(7, { title: "Changed" }, n, s, w);

describe("same-node protected draft planner (source semantics; not Drupal execution)", () => {
  it("plans one atomic update using the actual authorized non-default state, never create_content or status override", () => {
    expect(plan()).toEqual({
      nodeId: 7, nodeUuid: "node-uuid", bundle: "article", moderationState: "working",
      updates: { title: "Changed", moderation_state: "working" },
      proposed: { title: "Changed", status: false },
    });
    expect(node.status).toBe(true);
  });
  it.each([
    ["foreign node", { ...node, id: "8", nid: 8 }, state, workflow],
    ["unpublished default", { ...node, status: false }, state, workflow],
    ["unknown default status", { ...node, status: 2 }, state, workflow],
    ["unknown uuid", { ...node, uuid: "" }, state, workflow],
    ["wrong entity", node, { ...state, entity_type: "user" }, workflow],
    ["foreign moderation node", node, { ...state, entity_id: 8 }, workflow],
    ["different bundle", node, { ...state, bundle: "page" }, workflow],
    ["no workflow", node, { ...state, workflow_id: "" }, workflow],
    ["workflow mismatch", node, state, { ...workflow, id: "another" }],
    ["bundle not enrolled", node, state, { ...workflow, entity_types: { node: ["page"] } }],
    ["live metadata not published", node, { ...state, current_state: { ...state.current_state, published: false } }, workflow],
    ["live metadata not default", node, { ...state, current_state: { ...state.current_state, default_revision: false } }, workflow],
    ["unknown current state", node, { ...state, current_state: { ...state.current_state, id: "missing" } }, workflow],
    ["no per-user transition", node, { ...state, available_transitions: [] }, workflow],
    ["unknown permitted transition", node, { ...state, available_transitions: [{ id: "missing", to_state: "working" }] }, workflow],
    ["transition from another state", node, state, { ...workflow, transitions: { revise: { id: "revise", from: ["old"], to: "working" } } }],
    ["published target", node, state, { ...workflow, states: { ...workflow.states, working: { ...workflow.states.working, published: true } } }],
    ["default target", node, state, { ...workflow, states: { ...workflow.states, working: { ...workflow.states.working, default_revision: true } } }],
    ["untyped target flags", node, state, { ...workflow, states: { ...workflow.states, working: { ...workflow.states.working, published: "false" } } }],
    ["null moderation metadata", node, null, workflow],
    ["null workflow", node, state, null],
  ])("refuses %s", (_name, n, s, w) => {
    expect(() => plan(n, s, w)).toThrow(/protected|moderation|workflow/i);
  });
  it("refuses conflicting permission and workflow transition destinations", () => {
    expect(() => plan(node, { ...state, available_transitions: [{ id: "revise", to_state: "other" }] })).toThrow();
  });
  it("does not choose arbitrarily between two different safe editorial states", () => {
    expect(() => plan(node, {
      ...state, available_transitions: [...state.available_transitions, { id: "review", to_state: "checking" }],
    }, {
      ...workflow,
      states: { ...workflow.states, checking: { id: "checking", published: false, default_revision: false } },
      transitions: { ...workflow.transitions, review: { id: "review", from: ["live"], to: "checking" } },
    })).toThrow(/ambiguous/i);
  });
  it.each(["status", "moderation_state", "nid", "id", "uuid", "vid", "revision_default", "type", "bundle", "__proto__"])("caller cannot override %s", (key) => {
    const fields = Object.fromEntries([["title", "Changed"], [key, false]]);
    expect(() => planProtectedDraft(7, fields, node, state, workflow)).toThrow(/protected/i);
  });
});
