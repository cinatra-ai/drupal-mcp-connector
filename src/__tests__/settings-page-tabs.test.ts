// Tabbed setup-page contract (issue #65 — connector-setup-tabs rollout,
// app-connectors.html §II extended: tabbed setup page, Help tab always LAST).
//
// `DrupalSettingsPage` is an async server component composed from
// `@cinatra-ai/sdk-ui/*` primitives that this connector package does not
// resolve in isolation (host-provided at build time) and the repo's vitest
// environment is `node` (no DOM), so — matching the pattern already used by
// sibling connector-setup-tabs PRs in this rollout (e.g. the google-calendar
// connector's `setup-page-review.test.ts`) — these are source-text contract
// tests over the authored `../settings-page.tsx`, asserting: (a) the shared
// `sdk-ui` Tabs primitive is used (no vendored local `tabs.tsx`), (b) the
// Wide-column setup-page shell, (c) tab presence + order with Help last,
// (d) each tab's content mapping, and (e) mount-stability (forceMount) so a
// partially-typed form survives a tab switch.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("../settings-page.tsx", import.meta.url)),
  "utf8",
);

// Collapse insignificant JSX whitespace so multi-line elements match as text.
const flat = src.replace(/\s+/g, " ");

// The tabbed body — from the `nangoReady` guard onward, i.e. everything AFTER
// the Nango-not-configured early return — scoped so divider/Tabs assertions
// below can't accidentally match the early-return branch (which renders no
// tabs at all and carries no `divider` prop).
const tabbedBody = src.slice(src.indexOf("const instances = listMcpInstancesSorted()"));

describe("settings-page — shared sdk-ui Tabs primitive (boundary respect)", () => {
  it("imports the Tabs/TabsListRow/TabsTrigger/TabsContent parts from the shared @cinatra-ai/sdk-ui/tabs subpath", () => {
    const tabsImportLine = src
      .split("\n")
      .find((line) => line.includes('from "@cinatra-ai/sdk-ui/tabs"'));
    expect(tabsImportLine).toBeDefined();
    for (const part of ["Tabs", "TabsListRow", "TabsTrigger", "TabsContent"]) {
      expect(tabsImportLine).toMatch(new RegExp(`\\b${part}\\b`));
    }
  });

  it("does not vendor a local tabs.tsx copy inside this extension", () => {
    expect(
      existsSync(fileURLToPath(new URL("../components/ui/tabs.tsx", import.meta.url))),
    ).toBe(false);
    expect(
      existsSync(fileURLToPath(new URL("../tabs.tsx", import.meta.url))),
    ).toBe(false);
  });

  it("pairs the tab row with the shared TabsListRow (etched section rule) and turns off the tabbed page's own divider so the rule never stacks", () => {
    expect(tabbedBody).toContain("<TabsListRow>");
    // `divider={false}` must land on the ConnectorSetupPage invocation that
    // wraps the Tabs, not merely appear somewhere in the file.
    const setupPageToTabs = tabbedBody.slice(
      tabbedBody.indexOf("<ConnectorSetupPage"),
      tabbedBody.indexOf("<Tabs defaultValue="),
    );
    expect(setupPageToTabs).toMatch(/divider=\{false\}/);
  });
});

describe("settings-page — Wide-column setup-page shell (app-connectors.html §II)", () => {
  it("imports the shared ConnectorSetupPage shell from its own subpath", () => {
    expect(src).toMatch(
      /import\s*\{\s*ConnectorSetupPage\s*\}\s*from\s*"@cinatra-ai\/sdk-ui\/connector-setup-page"/,
    );
  });

  it("renders the tabbed body inside ConnectorSetupPage, not a hand-rolled max-w-7xl Main/PageHeader/PageContent shell", () => {
    expect(tabbedBody).toMatch(/<ConnectorSetupPage[\s\S]*?<Tabs defaultValue="setup"/);
    expect(tabbedBody).not.toMatch(/<Main\b/);
    expect(tabbedBody).not.toMatch(/<PageHeader\b/);
    expect(tabbedBody).not.toMatch(/<PageContent\b/);
  });

  it("both the Nango-not-configured branch and the tabbed branch use ConnectorSetupPage (exactly two usages)", () => {
    expect(src.match(/<ConnectorSetupPage\b/g)?.length).toBe(2);
  });
});

describe("settings-page — tab presence + order (Help always LAST)", () => {
  it('declares exactly two tab triggers, in order: "Setup" then "Help" — the last one is "help"', () => {
    const triggerValues = [...tabbedBody.matchAll(/<TabsTrigger value="([^"]+)">/g)].map(
      (m) => m[1],
    );
    expect(triggerValues).toEqual(["setup", "help"]);
  });

  it("declares exactly two TabsContent panels matching the two tab values, in the same order", () => {
    const contentValues = [...tabbedBody.matchAll(/<TabsContent\s+value="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(contentValues).toEqual(["setup", "help"]);
  });

  it("Tabs defaults to the Setup tab, not Help", () => {
    expect(tabbedBody).toMatch(/<Tabs defaultValue="setup"/);
  });
});

describe("settings-page — mount stability across a tab switch", () => {
  it('both TabsContent panels carry forceMount + data-[state=inactive]:hidden, so Radix keeps the inactive panel in the DOM (merely hidden) instead of unmounting it — a partially-typed "Add Drupal instance" form survives switching to Help and back', () => {
    const panelOpenTags = [
      ...tabbedBody.matchAll(/<TabsContent\s+value="[^"]+"[\s\S]*?>/g),
    ].map((m) => m[0]);
    expect(panelOpenTags).toHaveLength(2);
    for (const tag of panelOpenTags) {
      expect(tag).toMatch(/\bforceMount\b/);
      expect(tag).toContain("data-[state=inactive]:hidden");
    }
  });
});

describe("settings-page — content mapping per tab", () => {
  it('the "setup" TabsContent carries the add-instance form and the configured-instances list, unchanged', () => {
    const setupPanel = tabbedBody.slice(
      tabbedBody.indexOf('<TabsContent\n          value="setup"'),
      tabbedBody.indexOf('<TabsContent\n          value="help"'),
    );
    expect(setupPanel).toContain("Add Drupal instance");
    expect(setupPanel).toContain("action={saveInstanceAction}");
    expect(setupPanel).toContain("Configured instances");
    expect(setupPanel).toContain("action={deleteInstanceAction}");
  });

  it('the "help" TabsContent is read-only — no <form>, no Save/submit button', () => {
    const helpPanel = tabbedBody.slice(tabbedBody.indexOf('<TabsContent\n          value="help"'));
    expect(helpPanel).not.toContain("<form");
    expect(helpPanel).not.toContain("saveInstanceAction");
    expect(helpPanel).not.toContain("deleteInstanceAction");
    expect(helpPanel).not.toMatch(/type="submit"/);
  });

  it('the "help" TabsContent carries the connector\'s own setup how-to (prerequisites + the drush key command + how to add an instance)', () => {
    const helpPanel = tabbedBody.slice(tabbedBody.indexOf('<TabsContent\n          value="help"'));
    expect(helpPanel).toContain("Prerequisites");
    expect(helpPanel).toContain("mcp_tools");
    expect(helpPanel).toContain("drush mcp-tools:remote-key-create");
    expect(flat).toMatch(/On the\s*<b[^>]*>\s*Setup\s*<\/b>\s*tab/);
  });

  it('the "help" TabsContent narrows to the design system Narrow column (max-w-xl), per app-connectors.html §II', () => {
    const helpOpenTag = [...tabbedBody.matchAll(/<TabsContent\s+value="help"[\s\S]*?>/g)][0]?.[0];
    expect(helpOpenTag).toBeDefined();
    expect(helpOpenTag).toContain("max-w-xl");
  });
});
