import { registerDrupalPrimitives } from "./registry";

export function createDrupalModule() {
  return {
    registerCapabilities: registerDrupalPrimitives,
  };
}
