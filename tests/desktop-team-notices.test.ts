/**
 * 老板提醒的壳里规则（desktop/team-notices.js，2026-10-19 客户反馈第 1 条）：开关、合并、离线回来不刷屏、点开去哪
 */
import { describe, expect, it } from "vitest";
import 壳 from "../desktop/team-notices.js";
import 提醒 from "../desktop/reminders.js";

type 条 = { 类: string; 谁: string; 谁名: string; 名: string; 题?: string; 去: string; at: number };
const 起 = Date.UTC(2026, 9, 19, 9, 0, 0);
const 客户 = (谁: string, 名: string, at = 起, id = 名): 条 => ({ 类: "客户", 谁, 谁名: 谁 === "u1" ? "王磊" : 谁 === "u2" ? "李娜" : "赵强", 名, 去: `/customers/${id}`, at });
const 商机 = (谁: string, 名: string, at = 起): 条 => ({ 类: "商机", 谁, 谁名: "王磊", 名, 去: `/opportunities?opportunity=${名}`, at });
function 搭(现在 = 起) {
  let 钟 = 现在;
  const 发了: { title: string; body: string; 去: string; 收回了: boolean }[] = [];
  const r = 壳.创建同事提醒({ 发: (x: { title: string; body: string; 去: string }) => { const y = { ...x, 收回了: false }; 发了.push(y); return { ok: true, 收回: () => { y.收回了 = true; } }; }, 现在: () => 钟 });
  return { ...r, 发了, 还在: () => 发了.filter((x) => !x.收回了), 过: (ms: number) => { 钟 += ms; } };
}

describe("老板提醒：设置", () => {
  it("默认开客户和商机、跟进关；老设置文件里没有这三项的按默认补上", () => {
    expect(提醒.默认设置).toMatchObject({ 同事客户: true, 同事商机: true, 同事跟进: false });
    expect(提醒.规整设置({ 角标: true })).toMatchObject({ 同事客户: true, 同事商机: true, 同事跟进: false });
    expect(提醒.规整设置({ 同事客户: false, 同事跟进: true })).toMatchObject({ 同事客户: false, 同事商机: true, 同事跟进: true });
    // 只认 true：坏值不会把跟进提醒悄悄打开
    expect(提醒.规整设置({ 同事跟进: "yes" })).toMatchObject({ 同事跟进: false });
  });

  it("关掉的类不发；认不出来的、路径不对的条目不让壳出错", () => {
    const s = 搭();
    expect(s.收([客户("u1", "A"), 商机("u1", "X")], { ...提醒.默认设置, 同事客户: false })).toHaveLength(1);
    expect(s.发了.map((x) => x.title)).toEqual(["王磊 新建了商机"]);
    expect(壳.筛([null, { 类: "别的" }, { ...客户("u1", "B"), 去: "//evil.example" }], 提醒.默认设置)).toEqual([expect.objectContaining({ 名: "B", 去: "/customers" })]);
    expect(壳.筛("不是数组", 提醒.默认设置)).toEqual([]);
  });
});

describe("老板提醒：合并", () => {
  it("一条：标题说谁建了什么，正文是名字，点开去那一条", () => {
    const s = 搭();
    s.收([客户("u1", "Nordlicht GmbH", 起, "c1")], 提醒.默认设置);
    expect(s.发了).toEqual([{ title: "王磊 新建了客户", body: "Nordlicht GmbH", 去: "/customers/c1", 收回了: false }]);
  });

  it("同一个人一分钟内的合成一条（先发的收回）；过了一分钟另起", () => {
    const s = 搭();
    s.收([客户("u1", "A")], 提醒.默认设置);
    s.过(20_000);
    s.收([客户("u1", "B")], 提醒.默认设置);
    s.过(20_000);
    s.收([商机("u1", "X")], 提醒.默认设置);
    expect(s.还在().map((x) => [x.title, x.body, x.去])).toEqual([["王磊 新增 2 位客户、1 个商机", "A、B、X", "/customers"]]);
    expect(s.发了.filter((x) => x.收回了)).toHaveLength(2);
    s.过(60_000);
    s.收([客户("u1", "C")], 提醒.默认设置);
    expect(s.还在().map((x) => x.title)).toEqual(["王磊 新增 2 位客户、1 个商机", "王磊 新建了客户"]);
  });

  it("两个人各自合并，不串", () => {
    const s = 搭();
    s.收([客户("u1", "A"), 客户("u2", "B")], 提醒.默认设置);
    s.过(10_000);
    s.收([客户("u2", "C")], 提醒.默认设置);
    expect(s.还在().map((x) => x.title)).toEqual(["王磊 新建了客户", "李娜 新增 2 位客户"]);
  });

  it("同类好几条去列表页；同一条记录（一位客户和它的跟进）只在一条上就去那一条", () => {
    expect(壳.合并文案([客户("u1", "A"), 客户("u1", "B")]).去).toBe("/customers");
    expect(壳.合并文案([商机("u1", "X"), 商机("u1", "Y")]).去).toBe("/opportunities");
    const 跟进 = { 类: "跟进", 谁: "u1", 谁名: "王磊", 名: "A", 题: "", 去: "/customers/A", at: 起 };
    expect(壳.合并文案([客户("u1", "A"), 跟进]).去).toBe("/customers/A");
  });
});

describe("老板提醒：离线回来不刷屏", () => {
  it("攒下的（录了 5 分钟以上）整批一条汇总：「王磊等 3 人新增 12 位客户」，正文最多列 3 个名字", () => {
    const s = 搭(起 + 3600_000);
    const 一批 = [
      ...Array.from({ length: 6 }, (_, i) => 客户("u1", `王${i}`, 起 + i)),
      ...Array.from({ length: 4 }, (_, i) => 客户("u2", `李${i}`, 起 + 10 + i)),
      ...Array.from({ length: 2 }, (_, i) => 客户("u3", `赵${i}`, 起 + 20 + i)),
    ];
    expect(s.收(一批, 提醒.默认设置)).toHaveLength(1);
    expect(s.发了).toEqual([{ title: "王磊等 3 人新增 12 位客户", body: "王0、王1、王2 等", 去: "/customers", 收回了: false }]);
  });

  it("刚录的但一批里有 3 个人以上：也只发一条", () => {
    const s = 搭();
    s.收([客户("u1", "A"), 客户("u2", "B"), 客户("u3", "C")], 提醒.默认设置);
    expect(s.发了.map((x) => x.title)).toEqual(["王磊等 3 人新增 3 位客户"]);
  });

  it("汇总不进一分钟窗口：之后同一个人再录的照常单发", () => {
    const s = 搭(起 + 3600_000);
    s.收([客户("u1", "A", 起), 客户("u1", "B", 起)], 提醒.默认设置);
    s.收([客户("u1", "C", 起 + 3600_000)], 提醒.默认设置);
    expect(s.还在().map((x) => x.title)).toEqual(["王磊 新增 2 位客户", "王磊 新建了客户"]);
  });

  it("换数据目录清空窗口", () => {
    const s = 搭();
    s.收([客户("u1", "A")], 提醒.默认设置);
    s.清空();
    s.收([客户("u1", "B")], 提醒.默认设置);
    expect(s.还在()).toHaveLength(2);
  });
});
