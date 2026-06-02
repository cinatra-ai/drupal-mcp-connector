// Settings page consumers import
// `@cinatra-ai/drupal-mcp-connector/settings-page` directly.
export { createDrupalModule } from "./mcp/module";
export { registerDrupalPrimitives } from "./mcp/registry";
export { createDrupalPrimitiveHandlers } from "./mcp/handlers";
export {
  createDrupalWidgetChatTool,
  type DrupalWidgetContext,
  type DrupalFunctionTool,
  type DrupalToolParameterSchema,
} from "./widget-chat-tool";


// DI host-coupling escape.
export { registerDrupalConnector } from "./deps";
export type {
  DrupalConnectorDeps,
  DrupalDispatchContentEditorInput,
  DrupalNangoBearerHeaderInput,
} from "./deps";
