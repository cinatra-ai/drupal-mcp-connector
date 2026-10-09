import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODULE_READ_REVISION, MODULE_WRITE_DRAFT } from "../integration/module-protected-draft";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("the README states what the published-page draft tool does", () => {
  it("names the module tools the draft tool reads and writes through", () => {
    expect(readme).toContain(MODULE_READ_REVISION);
    expect(readme).toContain(MODULE_WRITE_DRAFT);
  });
  it("does not describe every published-page edit as refused", () => {
    expect(readme).not.toMatch(/currently refuses before content writes|refused before content writes until/);
  });
});
