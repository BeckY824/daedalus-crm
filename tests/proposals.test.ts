/**
 * 写入提议的校验。
 *
 * 这层是 AI 唯一能碰数据的入口，前端卡片上的值人还能再改一遍，所以它必须
 * 假定输入是敌意的：状态值、跟进类型、日期、必填项，错一个就拒。
 * 测试重点不在"合法的能过"，而在"不合法的一定过不去"。
 */
import { describe, it, expect } from "vitest";
import { buildProposal, describeProposal, missingFields, summarizeApplied } from "@/lib/agent/proposals";
import { dayjs } from "@/lib/utils";

const 客户 = { id: "c1", name: "陈同学" };
const 业务 = { sources: ["转介绍", "官网注册", "其他"] };
const 建 = (kind: Parameters<typeof buildProposal>[1], args: Record<string, unknown>) => buildProposal("p1", kind, 客户, args, 业务);
/** 取出提议，断言它成立——大多数用例只关心提议本身 */
const 提 = (kind: Parameters<typeof buildProposal>[1], args: Record<string, unknown>) => {
  const r = 建(kind, args);
  if (!r.ok) throw new Error(`本该成立却被拒：${r.error}`);
  return r.proposal;
};

describe("改状态的提议", () => {
  it("跟进状态与决策状态各自认得出来，不用调用方指定改哪个字段", () => {
    const a = 建("set_status", { to: "已签约", reason: "他说这周付款" });
    expect(a.ok && a.proposal.kind === "set_status" && a.proposal.field).toBe("followStatus");
    const b = 建("set_status", { to: "与家人商议", reason: "妈妈是决策人" });
    expect(b.ok && b.proposal.kind === "set_status" && b.proposal.field).toBe("decisionStatus");
  });

  it("编出来的状态值一律拒绝，并把合法取值告诉模型", () => {
    const r = 建("set_status", { to: "快成了", reason: "感觉不错" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("已签约");
  });

  it("不写理由不给提——人得知道为什么要改", () => {
    expect(建("set_status", { to: "已签约" }).ok).toBe(false);
  });
});

describe("记一条跟进的提议", () => {
  it("类型给中文标签或英文值都收", () => {
    const a = 建("add_followup", { type: "电话沟通", content: "聊了课程安排", reason: "他刚口述了一次通话" });
    const b = 建("add_followup", { type: "PHONE", content: "聊了课程安排", reason: "他刚口述了一次通话" });
    expect(a.ok && a.proposal.kind === "add_followup" && a.proposal.type).toBe("PHONE");
    expect(b.ok && b.proposal.kind === "add_followup" && b.proposal.type).toBe("PHONE");
  });

  it("不给时间就算刚刚发生，不留空", () => {
    const r = 建("add_followup", { type: "PHONE", content: "聊了课程安排", reason: "口述" });
    expect(r.ok && r.proposal.kind === "add_followup" && dayjs(r.proposal.occurredAt).isValid()).toBe(true);
  });

  it("内容太短的卡照样出，但拦住确认——让人在卡片上补，而不是回对话里打字", () => {
    const p = 提("add_followup", { type: "PHONE", content: "嗯", reason: "口述" });
    expect(missingFields(p)).toEqual(["沟通内容"]);
  });

  it("不认识的跟进类型会被拒，不会悄悄落成 OTHER", () => {
    expect(建("add_followup", { type: "心灵感应", content: "聊了课程安排", reason: "口述" }).ok).toBe(false);
  });
});

describe("排计划的提议", () => {
  it("常见日期写法能解析", () => {
    const r = 建("add_plan", { subject: "确认预算", plannedAt: "2026-09-15 19:00", method: "微信沟通", reason: "他说周一答复" });
    expect(r.ok && r.proposal.kind === "add_plan" && dayjs(r.proposal.plannedAt).format("MM-DD HH:mm")).toBe("09-15 19:00");
  });

  it("解析不了的时间要让模型重说，而不是落一个 Invalid Date", () => {
    const r = 建("add_plan", { subject: "确认预算", plannedAt: "改天吧", method: "微信沟通", reason: "他说周一答复" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("plannedAt");
  });

  it("时间和方式没给时出空卡让人挑，不当成错误", () => {
    const p = 提("add_plan", { subject: "确认预算", reason: "他说周一答复" });
    expect(missingFields(p)).toEqual(["时间", "方式"]);
  });

  it("跟进方式只能用系统里的那几种", () => {
    expect(建("add_plan", { subject: "确认预算", plannedAt: "2026-09-15 19:00", method: "托梦", reason: "x" }).ok).toBe(false);
  });
});

describe("给人看的描述", () => {
  it("抬头说清改谁、改成什么，业务名词跟着配置走", () => {
    const r = 建("set_status", { to: "已签约", reason: "他说这周付款" });
    expect(r.ok && describeProposal(r.proposal, "客户")).toBe("把客户「陈同学」的跟进状态改成「已签约」");
  });

  it("日志里能看出这条是人确认过的 AI 建议", () => {
    const r = 建("add_plan", { subject: "确认预算", plannedAt: "2026-09-15 19:00", method: "微信沟通", reason: "x" });
    expect(r.ok && summarizeApplied(r.proposal, "学员")).toContain("确认 AI 建议");
  });
});

describe("新建线索的提议", () => {
  it("只知道名字也出卡，来源与状态用默认值——缺信息不是拒绝的理由", () => {
    const p = 提("add_lead", { name: "吴小雯", reason: "用户要求新建一条线索" });
    expect(missingFields(p)).toEqual([]);
    expect(p.kind === "add_lead" && [p.source, p.status]).toEqual(["其他", "待跟进"]);
  });

  it("连名字都没有时拦住确认，而不是建一条无名线索", () => {
    expect(missingFields(提("add_lead", { reason: "用户要求新建" }))).toEqual(["名称"]);
  });

  it("来源必须是这套业务配置里有的，编的要拒", () => {
    expect(建("add_lead", { name: "吴小雯", source: "天上掉的", reason: "x" }).ok).toBe(false);
    expect(建("add_lead", { name: "吴小雯", source: "转介绍", reason: "x" }).ok).toBe(true);
  });

  it("抬头带上名字，人一眼知道这张卡要建谁", () => {
    expect(describeProposal(提("add_lead", { name: "吴小雯", reason: "x" }), "学员")).toBe("新建一条线索「吴小雯」");
  });
});
