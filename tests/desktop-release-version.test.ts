import { it, expect } from "vitest";
import { createRequire } from "node:module";
const { displayVersion, displayReleaseNotes } = createRequire(import.meta.url)("../desktop/release-version.js");

it("maintenance build displays the public version without changing later releases", () => {
  expect(displayVersion("0.46.16")).toBe("0.46.15");
  expect(displayVersion("0.46.15")).toBe("0.46.15");
  expect(displayVersion("0.46.17")).toBe("0.46.17");
});

it("public release notes retain both maintenance and original content", () => {
  const entries = [{ 版本: "0.46.16", 正文: "maintenance" }, { 版本: "0.46.15", 正文: "original" }, { 版本: "0.46.14", 正文: "older" }];
  expect(displayReleaseNotes(entries)).toEqual([
    { 版本: "0.46.15", 正文: "maintenance\n\noriginal" }, { 版本: "0.46.14", 正文: "older" },
  ]);
  expect(entries[0].版本).toBe("0.46.16");
});
