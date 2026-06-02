import { createDrupalPrimitiveHandlers } from "./mcp/handlers";

// Structural copies of `@cinatra-ai/llm`'s `LlmToolParameterSchema` /
// `LlmFunctionTool` (the only two shapes this connector consumes). Inlined so
// the connector carries no non-SDK `@cinatra-ai/*` code dependency. The host
// LLM orchestration consumes the returned tool by structural assignability.
export type DrupalToolParameterSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export type DrupalFunctionTool = {
  name: string;
  description: string;
  parameters: DrupalToolParameterSchema;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type DrupalWidgetContext = {
  instanceId?: unknown;
  nodeId?: unknown;
  nodeBundle?: unknown;
  nodeStatus?: unknown;
  href?: unknown;
};

/**
 * Build the LLM function-tool that the CMS widget chat route exposes for
 * editing the currently-open Drupal node.
 *
 * SECURITY (T-190-01 prompt-injection mitigation): the `instanceId` and
 * `nodeId` are forcibly overridden from the server-trusted request context
 * inside `execute()`. Any LLM-supplied identity values in `args` are dropped.
 * The LLM tool schema only declares `instructions` as a parameter — identity
 * is server-side only, never an LLM-controllable input.
 */
export function createDrupalWidgetChatTool(opts: { context: DrupalWidgetContext }): DrupalFunctionTool {
  const { context } = opts;
  const handlers = createDrupalPrimitiveHandlers();

  return {
    name: "drupal_content_editor_run",
    description:
      "Edit the currently-open Drupal node by passing natural-language instructions to the WayFlow drupal-content-editor agent. " +
      "Use whenever the user asks for any kind of content change to the current node (rewrite, tighten, fix typos, change title, add/remove text, restructure paragraphs). " +
      "Returns { nodeId, changes: [{ field, before, after }] } or { result: <text> } if the agent's reply isn't structured.",
    parameters: {
      type: "object" as const,
      properties: {
        instructions: {
          type: "string",
          description:
            "Natural-language editing instructions, derived from the user's chat message. " +
            "The server supplies instanceId and nodeId from the request context — do NOT pass them.",
        },
      },
      required: ["instructions"],
    } satisfies DrupalToolParameterSchema,
    execute: async (args: Record<string, unknown>) => {
      // SECURITY HARDENING (T-190-01): override identity fields with
      // server-trusted context values. Ignore any LLM-supplied instanceId / nodeId.
      // [IN-01 fix] Pass `undefined` (not "") for absent optional fields so
      // zod's `.default(...)` semantics fire — `.default()` only triggers on
      // `undefined`, not on empty strings.
      return handlers.drupal_content_editor_run({
        primitiveName: "drupal_content_editor_run",
        input: {
          instructions: typeof args.instructions === "string" ? args.instructions : "",
          instanceId: String(context.instanceId ?? ""),
          nodeId: String(context.nodeId ?? ""),
          nodeBundle:
            typeof context.nodeBundle === "string" && context.nodeBundle.length > 0
              ? context.nodeBundle
              : undefined,
          nodeStatus:
            typeof context.nodeStatus === "string" && context.nodeStatus.length > 0
              ? context.nodeStatus
              : undefined,
        },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      });
    },
  };
}
