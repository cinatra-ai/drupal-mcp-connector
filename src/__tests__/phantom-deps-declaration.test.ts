import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// #86 (follow-up to #83/#84): the same phantom-dependency class — an import
// that resolves only through the cinatra host's hoisted root `node_modules`
// symlink — existed for four more third-party specifiers. Each is declared
// below in the bucket its actual consumption pattern warrants, per AGENTS.md
// ("Third-party dependencies must be declared here"):
//
//   - `server-only` / `lucide-react` — production imports, `dependencies`.
//   - `next`                         — used at RUNTIME (`next/cache`,
//                                       `next/link`), not merely for its
//                                       `Metadata` type; the page renders
//                                       inside the HOST's own Next.js tree,
//                                       so this is a required `peerDependency`
//                                       (same shape as `react`/`react-dom`
//                                       here, and as `next` in the sibling
//                                       `linkedin-oauth-connector`).
//   - `vitest`                       — test-files-only, `devDependencies`.
//
// This is a manifest tripwire, not a live host check (this package's own CI
// skips typecheck/test for source mirrors — see AGENTS.md `## Tests`): it
// guards against re-introducing the phantom by deleting/misplacing a
// declaration, not against the host's own range moving away independently.

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

describe("server-only is declared in dependencies (#86)", () => {
  it("declares server-only in dependencies — not devDependencies, not undeclared", () => {
    // Imported for its side effect in three production files, all three of
    // which ship in the published `files` payload (`src/lib/drupal-mcp-client.ts`,
    // `src/mcp/toolbox.ts`, `src/settings-page.tsx` — confirmed via `npm pack --dry-run`).
    expect(manifest.dependencies?.["server-only"]).toBeDefined();
    expect(manifest.devDependencies?.["server-only"]).toBeUndefined();
  });

  it("matches the cinatra host's own range", () => {
    expect(manifest.dependencies?.["server-only"]).toBe("^0.0.1");
  });
});

describe("lucide-react is declared in dependencies (#86)", () => {
  it("declares lucide-react in dependencies — not devDependencies, not undeclared", () => {
    // Production import of `LinkIcon` in `src/settings-page.tsx`.
    expect(manifest.dependencies?.["lucide-react"]).toBeDefined();
    expect(manifest.devDependencies?.["lucide-react"]).toBeUndefined();
  });

  it("matches the cinatra host's own range", () => {
    expect(manifest.dependencies?.["lucide-react"]).toBe("^1.20.0");
  });
});

describe("next is declared as a required peerDependency (#86)", () => {
  it("declares next in peerDependencies — not dependencies, not devDependencies, not undeclared", () => {
    // `src/settings-page.tsx` imports `revalidatePath` from `next/cache` and
    // `Link` from `next/link` at RUNTIME (only the `Metadata` type import is
    // type-only) — the page renders inside the host's own Next.js tree, so
    // there is no separately-bundled Next.js runtime for this connector to
    // carry. A dependency/devDependency bucket would ship a second Next.js
    // copy this connector never actually uses standalone.
    expect(manifest.peerDependencies?.next).toBeDefined();
    expect(manifest.dependencies?.next).toBeUndefined();
    expect(manifest.devDependencies?.next).toBeUndefined();
  });

  it("matches the sibling linkedin-oauth-connector's range (and the host's 16.2.10)", () => {
    expect(manifest.peerDependencies?.next).toBe("^16.2.9");
  });

  it("is NOT marked optional — settings-page.tsx uses it unconditionally", () => {
    // Unlike the host-internal `@cinatra-ai/sdk-extensions` / `@cinatra-ai/sdk-ui`
    // peers (optional because a source-mirror clone of this repo can't resolve
    // them standalone), an unresolved `next` peer inside an actual Next.js host
    // should fail loudly, not silently degrade.
    expect(manifest.peerDependenciesMeta?.next).toBeUndefined();
  });
});

describe("vitest is declared in devDependencies (#86)", () => {
  it("declares vitest in devDependencies — not dependencies, not undeclared", () => {
    // Test-files-only: every file under src/__tests__/.
    expect(manifest.devDependencies?.vitest).toBeDefined();
    expect(manifest.dependencies?.vitest).toBeUndefined();
  });

  it("matches the cinatra host's own range", () => {
    expect(manifest.devDependencies?.vitest).toBe("^4.1.10");
  });
});
