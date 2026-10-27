/**
 * 跟进渠道自定义（D-48，2026-10-27）：配置清洗、名字 ↔ 值、藏了的不往新记录上落、保存前检查；
 * 云端按 key 放行管理员改渠道（scope-policy 改设置）、AI 记跟进、手机记跟进认自定义渠道
 */
import { describe, expect, it } from "vitest";
import { mergeFollowTypes, 新渠道值, 是自定义值, 全部跟进类型, 跟进类型表, 跟进类型元, 跟进类型值, 合法跟进类型, 跟进配置问题, 空跟进配置, 渠道名上限, type FollowTypeConfig } from "@/lib/follow-types";
import { 合并范围, 提取范围, 范围可写, type 范围索引 } from "@/lib/sync/scope-policy";
import type { 改动 } from "@/lib/sync/local";
import { sanitizeFollowUpDraft } from "@/lib/ai-draft";
import * as 手机 from "@/lib/mobile/sync";

const 抖音 = "C_douyin01";
const 展会 = "C_expo0001";
const 配置: FollowTypeConfig = {
  rename: { PHONE: "打电话" },
  hidden: ["SMS"],
  custom: [{ value: 抖音, label: "抖音私信" }, { value: 展会, label: "展会", hidden: true }, { value: "C_gone0001", label: "旧渠道", deleted: true }],
};

describe("配置清洗", () => {
  it("坏的丢掉、重复留第一个、名字去空白截长；改回原名的不算改名", () => {
    const c = mergeFollowTypes({
      rename: { PHONE: "  打  电话 ", EMAIL: "邮件沟通", NOPE: "x", WECHAT: "" },
      hidden: ["SMS", "SMS", "NOPE", 3],
      custom: [{ value: 抖音, label: "抖音私信" }, { value: 抖音, label: "重复的" }, { value: "bad", label: "x" }, { value: "C_noname1", label: "  " }, null, { value: 展会, label: "一二三四五六七八九十一二三四", hidden: true, deleted: "yes" }],
    });
    expect(c.rename).toEqual({ PHONE: "打 电话" });
    expect(c.hidden).toEqual(["SMS"]);
    expect(c.custom).toEqual([{ value: 抖音, label: "抖音私信" }, { value: 展会, label: "一二三四五六七八九十一二三四".slice(0, 渠道名上限), hidden: true }]);
    expect(mergeFollowTypes(null)).toEqual(空跟进配置);
    expect(mergeFollowTypes("乱码")).toEqual(空跟进配置);
  });

  it("新渠道值是 C_ 开头、避开已有的", () => {
    const v = 新渠道值([抖音]);
    expect(是自定义值(v)).toBe(true);
    expect(v).not.toBe(抖音);
  });
});

describe("名字 ↔ 值", () => {
  it("下拉顺序：内置渠道 → 自定义 → 任务、提醒、其他；藏了、删了的不在下拉里但认得名字", () => {
    const 能选 = 跟进类型表(配置).map((t) => t.value);
    expect(能选).toContain(抖音);
    expect(能选).not.toContain("SMS");
    expect(能选).not.toContain(展会);
    expect(能选).not.toContain("C_gone0001");
    expect(能选.slice(-3)).toEqual(["TASK", "REMIND", "OTHER"]);
    expect(能选.indexOf(抖音)).toBe(能选.length - 4);
    expect(跟进类型表(配置, false, { 只渠道: true }).map((t) => t.value)).not.toContain("TASK");
    expect(全部跟进类型(配置).map((t) => t.value)).toEqual(expect.arrayContaining(["SMS", 展会, "C_gone0001"]));
    expect(跟进类型元(配置, "C_gone0001").label).toBe("旧渠道");
  });

  it("改过的名、内置原名、英文值都认；藏了的、认不出的回 null", () => {
    expect(跟进类型值(配置, "打电话")).toBe("PHONE");
    expect(跟进类型值(配置, "电话沟通")).toBe("PHONE");
    expect(跟进类型值(配置, "phone")).toBe("PHONE");
    expect(跟进类型值(配置, "抖音私信")).toBe(抖音);
    expect(跟进类型值(配置, 抖音)).toBe(抖音);
    expect(跟进类型值(配置, "SMS")).toBeNull();
    expect(跟进类型值(配置, "展会")).toBeNull();
    expect(跟进类型值(配置, "飞鸽传书")).toBeNull();
    expect(跟进类型值(配置, "")).toBeNull();
    // 没配置照旧认内置
    expect(跟进类型值(undefined, "电话沟通")).toBe("PHONE");
  });

  it("认不出的值（别人新加、这台还没同步到）按「其他记录」显示", () => {
    const m = 跟进类型元(配置, "C_notsynced");
    expect(m.value).toBe("OTHER");
    expect(跟进类型元(配置, 抖音)).toMatchObject({ label: "抖音私信", icon: "tag", 自定义: true });
    expect(跟进类型元(配置, "PHONE").label).toBe("打电话");
  });

  it("存得进库：认得的都行（含藏了、删了的，老记录只改内容时要能存），认不出的不行", () => {
    for (const v of ["PHONE", "SMS", 抖音, 展会, "C_gone0001"]) expect(合法跟进类型(配置, v)).toBe(true);
    expect(合法跟进类型(配置, "C_notsynced")).toBe(false);
    expect(合法跟进类型(配置, 3)).toBe(false);
  });
});

describe("保存前检查", () => {
  it("名字重复、和内置重名都挡；删了的不算", () => {
    expect(跟进配置问题(配置)).toBeNull();
    expect(跟进配置问题({ ...配置, custom: [...配置.custom, { value: "C_dup00001", label: "抖音私信" }] })).toBe("渠道名「抖音私信」重复了");
    expect(跟进配置问题({ ...配置, custom: [{ value: "C_dup00001", label: "微信沟通" }] })).toBe("渠道名「微信沟通」重复了");
    expect(跟进配置问题({ ...配置, custom: [...配置.custom, { value: "C_dup00001", label: "旧渠道" }] })).toBeNull();
  });

  it("至少留一个能选的渠道（其他记录也算）", () => {
    const 全藏 = { rename: {}, hidden: 全部跟进类型(null).map((t) => t.value), custom: [] };
    expect(跟进配置问题(mergeFollowTypes(全藏))).toBe("至少留一个能选的渠道");
  });
});

describe("云端放行：管理员能改跟进渠道，改不了业务配置", () => {
  const event = (k: string, o: 改动["o"] = "I"): 改动 => ({ t: "Setting", k, r: { key: k, value: "{}" }, c: ["key", "value"], h: "1700000000000-test", o });
  const 行 = (k: string, o: 改动["o"] = "I"): 范围索引 => 合并范围(undefined, 提取范围(event(k, o)), 1);
  const rows = new Map<string, 范围索引>();
  const 限 = { 改设置: new Set(["followTypes"]) };

  it("followTypes：带改设置可写，不带不可写；老板一律可写", () => {
    expect(范围可写(undefined, 行("followTypes"), rows, "admin", false, false, false, 限)).toBe(true);
    expect(范围可写(undefined, 行("followTypes"), rows, "sales", false, true, true)).toBe(false);
    expect(范围可写(undefined, 行("business"), rows, "boss", true)).toBe(true);
  });

  it("business 管理员也不可写；删设置行一律不许", () => {
    expect(范围可写(undefined, 行("business"), rows, "admin", false, false, false, 限)).toBe(false);
    const old = 行("followTypes");
    const del = 合并范围(old, 提取范围({ ...event("followTypes", "D"), h: "1800000000000-test" }), 2);
    expect(del.deleted).toBe(true);
    expect(范围可写(old, del, rows, "admin", false, false, false, 限)).toBe(false);
  });
});

describe("AI 记跟进", () => {
  const ctx = { contactIds: ["c1"], opportunityIds: [], followTypes: 配置 };
  const 类型 = (type: unknown, c: Parameters<typeof sanitizeFollowUpDraft>[1] = ctx) => sanitizeFollowUpDraft({ followUp: { type, content: "聊了报价" } }, c).followUp.type;

  it("自定义渠道的名字或值都认，改过的名也认", () => {
    expect(类型("抖音私信")).toBe(抖音);
    expect(类型(抖音)).toBe(抖音);
    expect(类型("打电话")).toBe("PHONE");
    expect(类型("PHONE")).toBe("PHONE");
  });

  it("藏了的、认不出的落「其他记录」；没配置照旧", () => {
    expect(类型("SMS")).toBe("OTHER");
    expect(类型("展会")).toBe("OTHER");
    expect(类型("飞鸽传书")).toBe("OTHER");
    expect(类型("WECHAT", { contactIds: [], opportunityIds: [] })).toBe("WECHAT");
  });
});

describe("手机记跟进", () => {
  const 机 = { teamId: "t1", device: "m_phone", key: "", epoch: 0, keys: {}, userId: "acct_li", 私钥: new Uint8Array() } as unknown as 手机.手机团队;
  async function 新手机(渠道?: FollowTypeConfig) {
    const 库 = new 手机.内存库();
    const 状态 = 手机.新状态();
    const 放 = (t: string, k: string, r: Record<string, unknown>) => 库.放({ t, k, r, 钟: { name: "x" } });
    await 放("User", "acct_li", { id: "acct_li", name: "李娜" });
    if (渠道) await 放("Setting", "followTypes", { key: "followTypes", value: JSON.stringify(渠道) });
    await 放("Customer", "c1", { id: "c1", name: "Nordlicht", phone: "+491510001111", salesOwnerId: "acct_li" });
    return { 库, 状态 };
  }

  it("下拉有自定义渠道、没有藏了的；记自定义渠道存的是它的值，日志写它的名字", async () => {
    const 表 = 手机.手机跟进类型表(配置).map((t) => t.value);
    expect(表).toContain(抖音);
    expect(表).not.toContain("SMS");
    expect(表.at(-1)).toBe("OTHER");
    const { 库, 状态 } = await 新手机(配置);
    const { id } = await 手机.记跟进(机, 库, 状态, { customerId: "c1", type: 抖音, content: "发了样品视频" });
    expect((await 库.取("FollowUp", id))?.r.type).toBe(抖音);
    const 日志 = 状态.待推.find((e) => e.t === "AuditLog");
    expect(JSON.stringify(日志?.r)).toContain("抖音私信");
  });

  it("被藏的渠道（手机还停在旧下拉上）报「刚被停用」；认不出的报类型不对；都不写", async () => {
    const { 库, 状态 } = await 新手机(配置);
    await expect(手机.记跟进(机, 库, 状态, { customerId: "c1", type: "SMS", content: "x" })).rejects.toThrow("这个跟进方式刚被停用了");
    await expect(手机.记跟进(机, 库, 状态, { customerId: "c1", type: 展会, content: "x" })).rejects.toThrow("这个跟进方式刚被停用了");
    await expect(手机.记跟进(机, 库, 状态, { customerId: "c1", type: "C_notsynced", content: "x" })).rejects.toThrow("跟进类型不对");
    expect(状态.待推).toEqual([]);
  });

  it("还没同步到渠道设置：照旧内置那几种", async () => {
    const { 库, 状态 } = await 新手机();
    const { id } = await 手机.记跟进(机, 库, 状态, { customerId: "c1", type: "SMS", content: "x" });
    expect((await 库.取("FollowUp", id))?.r.type).toBe("SMS");
  });
});
