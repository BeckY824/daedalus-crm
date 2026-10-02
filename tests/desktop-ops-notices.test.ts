/**
 * 壳里的运营通知（desktop/ops-notices.js）：只发没发过的、游标往前走、问不到不动、
 * 停了之后游标文件删掉、点通知只会去运营台里的路径。
 * 「只有运营账号的电脑才起它」在 main.js 的 查运营台()，云端那道门在 tests/ops-notices.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const 运营通知 = require_("../desktop/ops-notices.js");

describe("纯规则", () => {
  it("只发没发过的键", () => {
    const 事件 = [{ key: "a", 标题: "x" }, { key: "b", 标题: "y" }, { 标题: "没键的不发" }];
    expect(运营通知.要发的(事件, { a: 1 }).map((e: { key: string }) => e.key)).toEqual(["b"]);
    expect(运营通知.要发的(null, {})).toEqual([]);
  });
  it("两天前的键扔掉", () => {
    const now = 10 * 86_400_000;
    expect(运营通知.清旧({ 老: now - 3 * 86_400_000, 新: now - 1000 }, now)).toEqual({ 新: now - 1000 });
  });
  it("去处只认 /admin 开头的路径", () => {
    expect(运营通知.去处("/admin/users/abc")).toBe("/admin/users/abc");
    expect(运营通知.去处("https://evil.example.com")).toBe("/admin");
    expect(运营通知.去处("//evil.example.com")).toBe("/admin");
    expect(运营通知.去处("/customers")).toBe("/admin");
    expect(运营通知.去处(undefined)).toBe("/admin");
  });
});

describe("串起来", () => {
  let 目录: string;
  let 文件: string;
  beforeEach(() => {
    vi.useFakeTimers();
    目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-ops-notices-"));
    文件 = path.join(目录, "ops-notices.json");
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(目录, { recursive: true, force: true });
  });

  it("第一次不带 since；之后带上回的 now；同一个键不发第二次；重启也不重发", async () => {
    const 问到: (string | null)[] = [];
    const 发了: string[] = [];
    const 回 = [
      { now: "2026-10-02T01:00:00.000Z", 事件: [] },
      { now: "2026-10-02T01:02:00.000Z", 事件: [{ key: "注册:1", 标题: "新用户：张三", 正文: "z@x.com", path: "/admin/users/1" }] },
      { now: "2026-10-02T01:04:00.000Z", 事件: [{ key: "注册:1", 标题: "新用户：张三", 正文: "z@x.com", path: "/admin/users/1" }] },
    ];
    const 起 = () =>
      运营通知.开始({
        文件,
        问: async (since: string | null) => {
          问到.push(since);
          return 回.shift() ?? null;
        },
        通知: (标题: string, _正文: string, 去处: string) => 发了.push(`${标题}→${去处}`),
      });
    const 器 = 起();
    await 器.刷新();
    await 器.刷新();
    await 器.刷新();
    expect(问到).toEqual([null, "2026-10-02T01:00:00.000Z", "2026-10-02T01:02:00.000Z"]);
    expect(发了).toEqual(["新用户：张三→/admin/users/1"]);

    // 「重启」：从文件接着问
    const 器2 = 起();
    回.push({ now: "2026-10-02T01:06:00.000Z", 事件: [{ key: "注册:1", 标题: "新用户：张三", 正文: "", path: "/admin/users/1" }] });
    await 器2.刷新();
    expect(问到.at(-1)).toBe("2026-10-02T01:04:00.000Z");
    expect(发了).toHaveLength(1);
    器.停();
    器2.停();
  });

  it("问不到：游标不动，下次接着从那儿问", async () => {
    const 问到: (string | null)[] = [];
    const 回: ({ now: string; 事件: unknown[] } | null)[] = [{ now: "2026-10-02T01:00:00.000Z", 事件: [] }, null];
    const 器 = 运营通知.开始({
      文件,
      问: async (since: string | null) => {
        问到.push(since);
        return 回.shift() ?? null;
      },
      通知: () => {},
    });
    await 器.刷新();
    await 器.刷新();
    await 器.刷新();
    expect(问到).toEqual([null, "2026-10-02T01:00:00.000Z", "2026-10-02T01:00:00.000Z"]);
    器.停();
  });

  it("停了：不再问，游标文件删掉", async () => {
    let 次 = 0;
    const 器 = 运营通知.开始({
      文件,
      问: async () => {
        次++;
        return { now: "2026-10-02T01:00:00.000Z", 事件: [] };
      },
      通知: () => {},
    });
    await 器.刷新();
    expect(fs.existsSync(文件)).toBe(true);
    器.停();
    expect(fs.existsSync(文件)).toBe(false);
    await 器.刷新();
    vi.advanceTimersByTime(10 * 60_000);
    expect(次).toBe(1);
  });
});
