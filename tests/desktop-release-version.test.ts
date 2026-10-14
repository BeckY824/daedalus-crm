import { it, expect } from "vitest";
import { createRequire } from "node:module";
const { displayVersion, displayReleaseNotes } = createRequire(import.meta.url)("../desktop/release-version.js");

it("显示的版本就是包的版本号，原样返回", () => {
  for (const v of ["0.46.14", "0.46.15", "v0.46.15", "0.47.0"]) expect(displayVersion(v)).toBe(v);
});

it("更新内容一版一段原样给，不合并、不改版本号，也不改调用方传进来的数组", () => {
  const entries = [{ 版本: "0.46.15", 正文: "this" }, { 版本: "0.46.14", 正文: "older" }];
  const out = displayReleaseNotes(entries);
  expect(out).toEqual([{ 版本: "0.46.15", 正文: "this" }, { 版本: "0.46.14", 正文: "older" }]);
  expect(out).not.toBe(entries);
  expect(displayReleaseNotes([])).toEqual([]);
});
