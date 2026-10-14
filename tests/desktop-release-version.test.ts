import { it, expect } from "vitest";
import { createRequire } from "node:module";
const { displayVersion, displayReleaseNotes } = createRequire(import.meta.url)("../desktop/release-version.js");

it("maintenance builds 0.46.16 / 0.46.17 display the public version without changing later releases", () => {
  expect(displayVersion("0.46.16")).toBe("0.46.15");
  expect(displayVersion("v0.46.17")).toBe("0.46.15");
  expect(displayVersion("0.46.17")).toBe("0.46.15");
  expect(displayVersion("0.46.15")).toBe("0.46.15");
  expect(displayVersion("0.46.18")).toBe("0.46.18");
  expect(displayVersion("0.47.0")).toBe("0.47.0");
});

it("public release notes retain both maintenance and original content", () => {
  const entries = [{ 版本: "0.46.16", 正文: "maintenance" }, { 版本: "0.46.15", 正文: "original" }, { 版本: "0.46.14", 正文: "older" }];
  expect(displayReleaseNotes(entries)).toEqual([
    { 版本: "0.46.15", 正文: "maintenance\n\noriginal" }, { 版本: "0.46.14", 正文: "older" },
  ]);
  expect(entries[0].版本).toBe("0.46.16");
});

it("final build 0.46.17 merges with both 0.46.16 and 0.46.15 notes", () => {
  const entries = [{ 版本: "0.46.17", 正文: "final" }, { 版本: "0.46.16", 正文: "maintenance" }, { 版本: "0.46.15", 正文: "original" }, { 版本: "0.46.14", 正文: "older" }];
  expect(displayReleaseNotes(entries)).toEqual([
    { 版本: "0.46.15", 正文: "final\n\nmaintenance\n\noriginal" }, { 版本: "0.46.14", 正文: "older" },
  ]);
  expect(displayReleaseNotes([{ 版本: "0.46.18", 正文: "next" }, { 版本: "0.46.17", 正文: "final" }])).toEqual([
    { 版本: "0.46.18", 正文: "next" }, { 版本: "0.46.15", 正文: "final" },
  ]);
});
