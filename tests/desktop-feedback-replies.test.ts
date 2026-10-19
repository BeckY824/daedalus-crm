/**
 * 壳里的「我们回复了你的反馈」系统通知（desktop/feedback-replies.js）：
 * 只叫没叫过的、第一次装上这一版只记不叫、一条和好几条的文案、云端老版本 / 没登录不记、
 * 没看过的那几条变了告诉窗口、问的这会儿换了账号不替上一个人叫。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const 反馈回复 = require_("../desktop/feedback-replies.js");

const 条 = (回复id: string, at: string, 回复 = `回复${回复id}`, feedbackId = `f_${回复id}`) => ({ feedbackId, 回复id, at, 回复 });

describe("纯规则", () => {
  it("只挑没叫过的；缺字段的丢掉", () => {
    const 未读 = [条("a", "1"), 条("b", "2"), { feedbackId: "x" }, null];
    expect(反馈回复.要提醒的(未读, ["a"]).map((x: { 回复id: string }) => x.回复id)).toEqual(["b"]);
    expect(反馈回复.要提醒的(undefined, [])).toEqual([]);
  });

  it("一条：标题固定、正文截 40 字、点了去那一串", () => {
    const 长 = "已经修好了，".repeat(20);
    const w = 反馈回复.文案([条("r1", "2026-10-19T08:00:00Z", 长, "fb/1")]);
    expect(w.title).toBe("我们回复了你的反馈");
    expect([...w.body]).toHaveLength(40);
    expect(w.body.endsWith("…")).toBe(true);
    expect(w.去).toBe("/feedback?id=fb%2F1");
  });

  it("好几条：一条通知说几条，正文是最新那句，点了去列表", () => {
    const w = 反馈回复.文案([条("a", "2026-10-18T00:00:00Z", "旧的"), 条("b", "2026-10-19T00:00:00Z", "新的\n第二行")]);
    expect(w).toEqual({ title: "我们回复了你的 2 条反馈", body: "新的 第二行", 去: "/feedback" });
  });

  it("签名只看是哪几条回复，不看顺序", () => {
    expect(反馈回复.签名([条("b", "2"), 条("a", "1")])).toBe(反馈回复.签名([条("a", "1"), 条("b", "2")]));
    expect(反馈回复.签名([条("a", "1")])).not.toBe(反馈回复.签名([条("a", "1"), 条("b", "2")]));
  });
});

describe("一轮一轮地问", () => {
  let 目录: string;
  let 文件: string;
  let 回: { 可用: boolean; 未读: unknown[] } | null;
  let 通知们: { title: string; body: string; 去: string }[];
  let 变了: number;
  let 器: { 刷新(马上?: boolean): Promise<void>; 停(): void } | null;

  beforeEach(() => {
    目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-fb-replies-"));
    文件 = path.join(目录, "feedback-notified.json");
    回 = { 可用: true, 未读: [] };
    通知们 = [];
    变了 = 0;
    器 = null;
  });
  afterEach(() => {
    器?.停();
    fs.rmSync(目录, { recursive: true, force: true });
  });

  const 起 = (取文件: () => string | null = () => 文件) => {
    器 = 反馈回复.开始({
      文件: 取文件,
      取端口: () => 3999,
      取令牌: () => "t",
      通知: (w: { title: string; body: string; 去: string }) => 通知们.push(w),
      有变化: () => 变了++,
      取: async (url: string, init: { headers: Record<string, string> }) => {
        expect(url).toBe("http://127.0.0.1:3999/api/desktop/feedback");
        expect(init.headers["x-desktop-token"]).toBe("t");
        if (!回) throw new Error("连不上");
        return { ok: true, json: async () => 回 };
      },
    });
    return 器!;
  };

  it("第一次装上这一版：升级前就有的回复只记不叫；之后来的新回复才叫，叫过不再叫", async () => {
    回 = { 可用: true, 未读: [条("老1", "1"), 条("老2", "2")] };
    const 器 = 起();
    await 器.刷新(true);
    expect(通知们).toEqual([]);
    expect(JSON.parse(fs.readFileSync(文件, "utf8")).已提醒).toEqual(["老1", "老2"]);

    回 = { 可用: true, 未读: [条("老1", "1"), 条("老2", "2"), 条("新", "3", "修好了")] };
    await 器.刷新(true);
    expect(通知们).toEqual([{ title: "我们回复了你的反馈", body: "修好了", 去: "/feedback?id=f_%E6%96%B0" }]);

    await 器.刷新(true);
    expect(通知们).toHaveLength(1);
  });

  it("云端是老版本 / 没登录（可用不是 true）：不叫也不记，等能用了再从头记", async () => {
    回 = { 可用: false, 未读: [] };
    const 器 = 起();
    await 器.刷新(true);
    expect(fs.existsSync(文件)).toBe(false);
    回 = null;
    await 器.刷新(true);
    expect(fs.existsSync(文件)).toBe(false);
    expect(通知们).toEqual([]);
  });

  it("没看过的那几条变了才告诉窗口，第一轮不算", async () => {
    fs.writeFileSync(文件, JSON.stringify({ 已提醒: [] }));
    const 器 = 起();
    await 器.刷新(true);
    expect(变了).toBe(0);
    回 = { 可用: true, 未读: [条("a", "1")] };
    await 器.刷新(true);
    expect(变了).toBe(1);
    await 器.刷新(true);
    expect(变了).toBe(1);
    // 人在应用里看过了：没看过的变成空，红点也要跟着掉
    回 = { 可用: true, 未读: [] };
    await 器.刷新(true);
    expect(变了).toBe(2);
  });

  it("切回应用：5 分钟内问过就不再问", async () => {
    fs.writeFileSync(文件, JSON.stringify({ 已提醒: [] }));
    const 器 = 起();
    await 器.刷新(true);
    回 = { 可用: true, 未读: [条("a", "1")] };
    await 器.刷新();
    expect(通知们).toEqual([]);
    await 器.刷新(true);
    expect(通知们).toHaveLength(1);
  });

  it("问的这会儿换了账号：不往新账号的文件里记、不替上一个人叫", async () => {
    const 另一个 = path.join(目录, "b.json");
    fs.writeFileSync(文件, JSON.stringify({ 已提醒: [] }));
    let 当前 = 文件;
    回 = { 可用: true, 未读: [条("a", "1")] };
    const 器 = 反馈回复.开始({
      文件: () => 当前,
      取端口: () => 3999,
      取令牌: () => "t",
      通知: (w: { title: string; body: string; 去: string }) => 通知们.push(w),
      取: async () => {
        当前 = 另一个;
        return { ok: true, json: async () => 回 };
      },
    });
    await 器.刷新(true);
    器.停();
    expect(通知们).toEqual([]);
    expect(fs.existsSync(另一个)).toBe(false);
  });
});

describe("打包", () => {
  it("feedback-replies.js 在安装包的文件清单里，main.js 起了它、preload 给了窗口 onChanged", () => {
    const 根 = path.resolve(__dirname, "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(根, "desktop/package.json"), "utf8"));
    expect(pkg.build.files).toContain("feedback-replies.js");
    const main = fs.readFileSync(path.join(根, "desktop/main.js"), "utf8");
    expect(main).toContain('require("./feedback-replies")');
    expect(main).toContain('"feedback:changed"');
    const preload = fs.readFileSync(path.join(根, "desktop/preload-app.js"), "utf8");
    expect(preload).toContain('"desktopFeedback"');
  });
});
