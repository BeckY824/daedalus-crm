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
