/**
 * 壳里的提醒（desktop/reminders.js）：发不发、发几次、说什么、Dock 写几。
 *
 * 通知的失败方式是两头的：该发的没发，人错过了；不该发的发了、或者一件事发三遍，
 * 人就去系统设置里把我们整个关掉——那之后该发的也再发不出去了。所以两头都钉。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const 提醒 = require_("../desktop/reminders.js");

const 设 = (部分 = {}) => 提醒.规整设置(部分);
const 空状态 = () => ({ 早报日: null as string | null, 已提醒: [] as string[] });
/** 2026-09-28 上午 9:30，本机时区 */
const 早上 = new Date(2026, 8, 28, 9, 30);

describe("Dock 上的数只有一个意思", () => {
  it("逾期 + 今天；关了开关就是 0；问不到也是 0", () => {
    expect(提醒.角标数(设(), { 逾期: 2, 今天: 3 })).toBe(5);
    expect(提醒.角标数(设({ 角标: false }), { 逾期: 2, 今天: 3 })).toBe(0);
    expect(提醒.角标数(设(), null)).toBe(0);
  });
});

describe("早上一条，不是 N 条", () => {
  const 摘要 = { 逾期: 2, 今天: 1, 定时: [], 最久: { 客户: "李娜", 天: 4 } };

  it("到点之后发，没到不发", () => {
    expect(提醒.该发早报(设({ 早报时间: "09:00" }), 空状态(), 摘要, 早上)).toBe(true);
    expect(提醒.该发早报(设({ 早报时间: "10:00" }), 空状态(), 摘要, 早上)).toBe(false);
  });

  it("今天发过就不再发；到了明天又发", () => {
    const 状态 = { ...空状态(), 早报日: 提醒.今天串(早上) };
    expect(提醒.该发早报(设(), 状态, 摘要, 早上)).toBe(false);
    expect(提醒.该发早报(设(), 状态, 摘要, new Date(2026, 8, 29, 9, 30))).toBe(true);
  });

  it("没有要跟进的不发——「今天没事」不值得打扰人", () => {
    expect(提醒.该发早报(设(), 空状态(), { 逾期: 0, 今天: 0, 定时: [], 最久: null }, 早上)).toBe(false);
  });

  it("关了开关不发", () => {
    expect(提醒.该发早报(设({ 早报: false }), 空状态(), 摘要, 早上)).toBe(false);
  });

  it("说几个、逾期几个、点名最久的；没有逾期的就说「都是今天的」", () => {
    expect(提醒.早报文案(摘要)).toEqual({ 标题: "今天有 3 个要跟进", 正文: "其中 2 个已经逾期，最久的是李娜，已经拖了 4 天" });
    expect(提醒.早报文案({ 逾期: 0, 今天: 2, 定时: [], 最久: null }).正文).toBe("都是今天的，还没有逾期的");
  });

  it("时间写坏了按 9 点，不让一个坏设置把早报整个吞掉", () => {
    expect(设({ 早报时间: "早上" }).早报时间).toBe("09:00");
    expect(提醒.今天的("25:99", 早上).getHours()).toBe(23);
  });
});

describe("到点只叫一次", () => {
  const 一条 = (分钟前: number, key = "plan:p1") => ({
    key,
    at: new Date(早上.getTime() - 分钟前 * 60_000).toISOString(),
    标题: "给王总回电话",
    客户: "王总",
    customerId: "c1",
    方式: "电话沟通",
  });

  it("到了就发；还没到、过了 10 分钟以上的都不发", () => {
    const 摘要 = { 逾期: 0, 今天: 3, 定时: [一条(1, "a"), 一条(-5, "b"), 一条(30, "c")], 最久: null };
    expect(提醒.该到点的(设(), 空状态(), 摘要, 早上).map((x: { key: string }) => x.key)).toEqual(["a"]);
  });

  it("提醒过的不再提醒；同一条改了时间算新的一条", () => {
    const x = 一条(1);
    const 状态 = { ...空状态(), 已提醒: [`${x.key}@${x.at}`] };
    expect(提醒.该到点的(设(), 状态, { 逾期: 0, 今天: 1, 定时: [x], 最久: null }, 早上)).toEqual([]);
    const 改了时间 = { ...x, at: new Date(早上.getTime() - 30_000).toISOString() };
    expect(提醒.该到点的(设(), 状态, { 逾期: 0, 今天: 1, 定时: [改了时间], 最久: null }, 早上)).toHaveLength(1);
  });

  it("关了开关不发", () => {
    expect(提醒.该到点的(设({ 到点: false }), 空状态(), { 逾期: 0, 今天: 1, 定时: [一条(1)], 最久: null }, 早上)).toEqual([]);
  });

  it("文案：标题说做什么，正文说是谁、怎么联系", () => {
    expect(提醒.到点文案(一条(1))).toEqual({ 标题: "到点了：给王总回电话", 正文: "王总 · 电话沟通" });
  });

  it("两天前的记录清掉，文件不会越长越大", () => {
    const 旧 = `plan:x@${new Date(早上.getTime() - 3 * 86_400_000).toISOString()}`;
    const 新 = `plan:y@${new Date(早上.getTime() - 3_600_000).toISOString()}`;
    expect(提醒.清旧([旧, 新], 早上)).toEqual([新]);
  });
});

describe("串起来：问服务、发通知、记下来、重启不重发", () => {
  let 目录: string;
  let 文件: string;
  beforeEach(() => {
    vi.useFakeTimers();
    目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-reminders-"));
    文件 = path.join(目录, "reminders.json");
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(目录, { recursive: true, force: true });
  });

  const 摘要 = {
    逾期: 1,
    今天: 1,
    定时: [{ key: "plan:p1", at: new Date(早上.getTime() - 60_000).toISOString(), 标题: "给王总回电话", 客户: "王总", customerId: "c1", 方式: null }],
    最久: { 客户: "李娜", 天: 2 },
  };
  const 起 = (通知: (标题: string, 正文: string, 路径: string) => void, 角标: (n: number) => void, 回 = 摘要) =>
    提醒.开始({
      文件,
      取端口: () => 3100,
      取令牌: () => "desktop-token-for-tests",
      通知,
      设角标: 角标,
      现在: () => 早上,
      fetch: async (_url: string, init: { headers: Record<string, string> }) => {
        expect(init.headers["x-desktop-token"]).toBe("desktop-token-for-tests");
        return { ok: true, json: async () => 回 };
      },
    });

  it("一轮：到点那条和早报各发一次，点了各去对的页；Dock 写 2", async () => {
    const 发了: [string, string, string][] = [];
    const 角标: number[] = [];
    const r = 起((a, b, c) => 发了.push([a, b, c]), (n) => 角标.push(n));
    await r.刷新();
    r.停();
    expect(发了).toEqual([
      // 带上是哪一条（plan:p1），记录页据此把它闪一下
      ["到点了：给王总回电话", "王总", "/customers/c1?focus=plan%3Ap1"],
      ["今天有 2 个要跟进", "其中 1 个已经逾期，最久的是李娜，已经拖了 2 天", "/follow-ups/plans"],
    ]);
    expect(角标[0]).toBe(2);
  });

  it("再问一轮、甚至重启应用（换一个新的 开始()），都不重发", async () => {
    const 发了: string[] = [];
    const 第一次 = 起((a) => 发了.push(a), () => {});
    await 第一次.刷新();
    await 第一次.刷新();
    第一次.停();
    const 重启后 = 起((a) => 发了.push(a), () => {});
    await 重启后.刷新();
    重启后.停();
    expect(发了).toHaveLength(2);
  });

  it("关掉 Dock 数字立刻清成 0，不等下一分钟", async () => {
    const 角标: number[] = [];
    const r = 起(() => {}, (n) => 角标.push(n));
    await r.刷新();
    r.改设置({ 角标: false });
    r.停();
    expect(角标).toEqual([2, 0, 0]);
  });

  it("没有可问的（切去了服务器模式）：Dock 清成 0，不挂着一个过期的数", async () => {
    const 角标: number[] = [];
    let 有端口 = true;
    const r = 提醒.开始({
      文件,
      取端口: () => (有端口 ? 3100 : null),
      取令牌: () => "desktop-token-for-tests",
      通知: () => {},
      设角标: (n: number) => 角标.push(n),
      现在: () => 早上,
      fetch: async () => ({ ok: true, json: async () => 摘要 }),
    });
    await r.刷新();
    有端口 = false;
    await r.刷新();
    r.停();
    // 最后那个 0 是 停() 清的：退出应用时 Dock 上不留一个没人再更新的数
    expect(角标).toEqual([2, 0, 0]);
  });

  it("设置只认那四个字段，多塞的丢掉", () => {
    const r = 起(() => {}, () => {});
    const s = r.改设置({ 早报时间: "08:30", 多余: "x" });
    r.停();
    expect(s).toEqual({ 角标: true, 早报: true, 早报时间: "08:30", 到点: true });
    expect(JSON.parse(fs.readFileSync(文件, "utf8")).设置).toEqual(s);
  });
});
