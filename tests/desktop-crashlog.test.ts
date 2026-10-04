/** 崩溃日志与诊断信息（desktop/crashlog.js）。 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require_ = createRequire(import.meta.url);
const 崩 = require_("../desktop/crashlog.js");

let 沙盒: string;
beforeEach(() => {
  沙盒 = fs.mkdtempSync(path.join(os.tmpdir(), "crash-test-"));
});
afterEach(() => fs.rmSync(沙盒, { recursive: true, force: true }));

describe("写崩溃日志", () => {
  it("追加写，目录不存在就建，块里有时间、标题、环境和堆栈", () => {
    const f = path.join(沙盒, "logs", "app.log");
    崩.写崩溃日志(f, "未捕获的异常", new Error("坏了"), { 版本: "0.23.0", 模式: "local" });
    崩.写崩溃日志(f, "第二次", "字符串错误");
    const 内容 = fs.readFileSync(f, "utf8");
    expect(内容).toMatch(/==== \d{4}-\d{2}-\d{2}T.* 未捕获的异常 ====/);
    expect(内容).toContain("版本: 0.23.0");
    expect(内容).toContain("Error: 坏了");
    expect(内容).toMatch(/at .*crashlog\.test/);
    expect(内容).toContain("==== ");
    expect(内容).toContain("第二次");
    expect(内容).toContain("字符串错误");
  });

  it("写不进去也不抛——报错路径上再炸一次只会把信息全丢", () => {
    expect(() => 崩.写崩溃日志("/nonexistent-root-dir/x/app.log", "t", new Error("e"))).not.toThrow();
  });
});

describe("诊断信息", () => {
  it("一行一个字段，空的不出现", () => {
    const t = 崩.诊断信息({ 版本: "0.23.0", 系统: "macOS 15.5", 空: "", 无: undefined });
    expect(t).toBe("版本: 0.23.0\n系统: macOS 15.5");
  });
});

describe("日志尾巴", () => {
  it("给最后几行；文件不存在给空串", () => {
    const f = path.join(沙盒, "a.log");
    fs.writeFileSync(f, Array.from({ length: 50 }, (_, i) => `行${i}`).join("\n"));
    expect(崩.日志尾巴(f, 3)).toBe("行47\n行48\n行49");
    expect(崩.日志尾巴(path.join(沙盒, "none.log"))).toBe("");
  });
});

/*
  渲染进程没了怎么办（2026-10-04，D-033）：一分钟内最多自动重载 3 次，第 4 次问人——
  原来直接 return，窗口一直白着、没弹框没出口，只能强退
*/
describe("渲染退出怎么办", () => {
  const 怎么办 = 崩.渲染退出怎么办 as (o: { 原因: string; 记录: number[]; 现在: number; 正在问?: boolean }) => { 动作: string; 记录: number[] };

  it("正常退出不管", () => {
    expect(怎么办({ 原因: "clean-exit", 记录: [], 现在: 1000 }).动作).toBe("不管");
  });

  it("一分钟内前三次自动重载，第四次问人", () => {
    let 记录: number[] = [];
    const 动作: string[] = [];
    for (const t of [0, 5_000, 10_000, 15_000]) {
      const r = 怎么办({ 原因: "crashed", 记录, 现在: t });
      记录 = r.记录;
      动作.push(r.动作);
    }
    expect(动作).toEqual(["重载", "重载", "重载", "问人"]);
  });

  it("正在问着又崩了：不再叠一个框", () => {
    expect(怎么办({ 原因: "crashed", 记录: [0, 1, 2], 现在: 3, 正在问: true }).动作).toBe("不管");
  });

  it("隔了一分钟以上的旧记录不算：又能自动重载", () => {
    expect(怎么办({ 原因: "killed", 记录: [0, 1, 2], 现在: 61_000 }).动作).toBe("重载");
  });

  it("main.js 用的是这个函数，问人那一支给了「再试一次 / 打开日志 / 退出」", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../desktop/main.js"), "utf8");
    expect(src).toContain("崩溃.渲染退出怎么办(");
    expect(src).toMatch(/buttons: \["再试一次", "打开日志", "退出"\]/);
    expect(src).not.toMatch(/if \(重载记录\.length >= 3\) return;/);
  });
});
