import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { registerDrupalPrimitives } from "../mcp/registry";

// cinatra#3745: builds before `drupal_node_read_for_edit` carried 0.1.7 (and
// lower), so the first version with the tool is 0.1.8. A pack states its need
// of the tool as a version range only if no build without it shares a number.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function semverParts(version: string) {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`not a strict SemVer version: ${version}`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] };
}

// A prerelease of a core version is below that core version.
function semverAtLeast(version: string, floor: string): boolean {
  const a = semverParts(version);
  const b = semverParts(floor);
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  return a.prerelease === undefined || b.prerelease !== undefined;
}

describe("package version when drupal_node_read_for_edit is registered (cinatra#3745)", () => {
  it("compares strict SemVer", () => {
    const pre = (core: string) => [core, "rc.1"].join("-");
    expect(semverAtLeast("0.1.8", "0.1.8")).toBe(true);
    expect(semverAtLeast("0.1.10", "0.1.8")).toBe(true);
    expect(semverAtLeast("0.2.0", "0.1.8")).toBe(true);
    expect(semverAtLeast("0.1.7", "0.1.8")).toBe(false);
    expect(semverAtLeast(pre("0.1.8"), "0.1.8")).toBe(false);
    expect(semverAtLeast(pre("0.1.9"), "0.1.8")).toBe(true);
    expect(() => semverParts("0.1")).toThrow();
    expect(() => semverParts("0.1.08")).toThrow();
    expect(() => semverParts("0.1.x")).toThrow();
  });

  it("is at least 0.1.8 whenever the registration declares the tool", () => {
    const registered: string[] = [];
    const server = {
      registerTool: (name: string) => {
        registered.push(name);
      },
    } as unknown as Parameters<typeof registerDrupalPrimitives>[0];
    registerDrupalPrimitives(server);
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    if (registered.includes("drupal_node_read_for_edit")) {
      expect(semverAtLeast(pkg.version, "0.1.8")).toBe(true);
    }
    expect(registered).toContain("drupal_node_read_for_edit");
  });
});

// cinatra#246 regression guard. The content-editor RELAY (`drupal_content_editor_run`)
// must NOT be registered as a self-MCP tool: when the drupal-content-editor
// agent has the cinatra MCP server injected, a visible dispatcher tool let the
// model call it and re-dispatch itself (observed recursive mcp_call -> 504).
// The host relays to the agent directly via dispatchContentEditorViaA2A; the
// relay handler still exists in the map but must never reach tools/list.
describe("registerDrupalPrimitives — relay is NOT a model-visible MCP tool (cinatra#246)", () => {
  it("registers the real read/write primitives but OMITS drupal_content_editor_run", () => {
    const registered: string[] = [];
    const server = {
      registerTool: (name: string) => {
        registered.push(name);
      },
    } as unknown as Parameters<typeof registerDrupalPrimitives>[0];

    registerDrupalPrimitives(server);

    // Real CMS primitives the SKILL.md names are present...
    expect(registered).toContain("drupal_node_get");
    expect(registered).toContain("drupal_node_update");
    // ...but the dispatcher relay is excluded from the MCP surface.
    expect(registered).not.toContain("drupal_content_editor_run");
  });
});
