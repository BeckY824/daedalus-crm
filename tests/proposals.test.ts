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

const 客户 = { id: "c1", name: "陈立" };
/* 默认那套通用措辞：公司 / 职位 / 行业。校验「职位」那一格时用的就是这里的 grades */
const 业务 = {
  sources: ["转介绍", "官网注册", "其他"],
  fields: { school: "公司", grade: "职位", major: "行业" },
  grades: ["创始人 / 老板", "高管", "部门负责人", "经办人", "技术", "财务", "其他"],
};
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
    expect(r.ok && describeProposal(r.proposal, "客户")).toBe("把客户「陈立」的跟进状态改成「已签约」");
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

describe("改档案的提议", () => {
  it("只写要改的那几项，不改的不出现在卡片上", () => {
    const p = 提("update_customer", { changes: { followStatus: "已签约", remark: "家长同意了" }, reason: "刚谈完" });
    expect(p.kind === "update_customer" && p.changes.map((c) => c.field).sort()).toEqual(["followStatus", "remark"]);
  });

  it("编出来的字段名一律拒，并把能改的告诉模型", () => {
    const r = 建("update_customer", { changes: { 学费: "两万" }, reason: "x" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("salesOwnerName");
  });

  it("枚举值给错当场拒——「差不多要签了」不是合法状态", () => {
    const r = 建("update_customer", { changes: { followStatus: "差不多要签了" }, reason: "x" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("已签约");
  });

  it("日期解析不了要拒，不能悄悄当成空", () => {
    expect(建("update_customer", { changes: { expectedSignAt: "下个礼拜吧" }, reason: "x" }).ok).toBe(false);
    const p = 提("update_customer", { changes: { expectedSignAt: "2026-10-01" }, reason: "x" });
    expect(p.kind === "update_customer" && dayjs(p.changes[0].value).format("YYYY-MM-DD")).toBe("2026-10-01");
  });

  it("关系字段收的是名字不是 id——把 id 交给模型等于让它编一个出来", () => {
    const p = 提("update_customer", { changes: { salesOwnerName: "江城", referrerName: "赵同学" }, reason: "x" });
    if (p.kind !== "update_customer") throw new Error("类型不对");
    expect(p.changes.find((c) => c.field === "salesOwnerName")?.value).toBe("江城");
    expect(p.changes.find((c) => c.field === "referrerName")?.value).toBe("赵同学");
  });

  it("姓名和负责人不能留空，其余字段留空是合法的「清掉这一项」", () => {
    const 清姓名 = 提("update_customer", { changes: { name: "" }, reason: "x" });
    expect(missingFields(清姓名)).toContain("姓名");
    const 清备注 = 提("update_customer", { changes: { remark: "" }, reason: "x" });
    expect(missingFields(清备注)).toEqual([]);
  });

  it("空的 changes 不给提——一张什么都不改的卡片只会让人困惑", () => {
    expect(建("update_customer", { changes: {}, reason: "x" }).ok).toBe(false);
  });

  it("抬头要说清改的是哪几项", () => {
    const p = 提("update_customer", { changes: { followStatus: "已签约", expectedSignAt: "2026-10-01" }, reason: "x" });
    const t = describeProposal(p, "学员");
    expect(t).toContain("陈立");
    expect(t).toContain("跟进状态");
    expect(t).toContain("预计签约");
  });
});

describe("商机与签约的提议", () => {
  it("阶段给错要拒，并把合法阶段告诉模型", () => {
    const r = 建("add_opportunity", { name: "秋季班", amount: 19800, stage: "快成了", reason: "x" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("谈判审核");
  });

  it("没给概率时按阶段推一个，不留空让人瞎填", () => {
    const p = 提("add_opportunity", { name: "秋季班", amount: 19800, stage: "谈判审核", reason: "x" });
    expect(p.kind === "add_opportunity" && p.probability).toBeGreaterThan(0);
  });

  it("概率越界要拒——它参与加权预测，越界会让预测数字失真", () => {
    expect(建("add_opportunity", { name: "x", amount: 1, stage: "初步沟通", probability: 180, reason: "x" }).ok).toBe(false);
  });

  it("负数金额一律拒，商机和签约都是", () => {
    expect(建("add_opportunity", { name: "x", amount: -1, stage: "初步沟通", reason: "x" }).ok).toBe(false);
    expect(建("add_contract", { amount: -1, signedAt: "2026-09-01", reason: "x" }).ok).toBe(false);
  });

  it("模型爱写「¥19,800」这种，要收得住", () => {
    const p = 提("add_contract", { amount: "¥19,800", signedAt: "2026-09-01", reason: "x" });
    expect(p.kind === "add_contract" && p.amount).toBe(19800);
  });

  it("金额和日期没填时出卡片但不让确认——留空是让人补，不是拒绝提议", () => {
    const p = 提("add_contract", { signedAt: "", reason: "x" });
    expect(missingFields(p).length).toBeGreaterThan(0);
  });

  it("落库日志要分得清商机和签约——一个在谈一个已成交", () => {
    const 商机 = 提("add_opportunity", { name: "秋季班", amount: 19800, stage: "初步沟通", reason: "x" });
    const 签约 = 提("add_contract", { amount: 19800, signedAt: "2026-09-01", reason: "x" });
    expect(summarizeApplied(商机, "学员")).toContain("商机");
    expect(summarizeApplied(签约, "学员")).toContain("签约");
  });
});

describe("改渠道的提议", () => {
  it("渠道负责人有两条路：改某一位学员走客户卡，改渠道本身走渠道卡", () => {
    // 单个订正（登记错误）：只动这一位，同渠道其他人不变
    const 单个 = 提("update_customer", { changes: { channelOwnerName: "张沁" }, reason: "登记错了" });
    expect(单个.kind === "update_customer" && 单个.changes[0]).toEqual({ field: "channelOwnerName", value: "张沁" });

    // 换人接手：改渠道，只影响之后新增的学员
    const 整个 = 提("update_channel", { channelName: "林老师（附中）", ownerName: "张沁", reason: "x" });
    expect(整个.kind === "update_channel" && 整个.ownerName).toBe("张沁");

    // 两条路都不能把销售的名字塞进「来源渠道」——那是渠道名，服务端会拒
    const 塞错 = 提("update_customer", { changes: { channelName: "张沁" }, reason: "x" });
    expect(塞错.kind === "update_customer" && 塞错.changes[0].field).toBe("channelName");
  });

  it("不说改哪个渠道就不给提", () => {
    expect(建("update_channel", { ownerName: "张沁", reason: "x" }).ok).toBe(false);
  });

  it("三项都空等于什么都不改，拦住确认", () => {
    const p = 提("update_channel", { channelName: "林老师（附中）", reason: "x" });
    expect(missingFields(p)).toContain("要改什么");
  });

  it("抬头要说清改的是渠道，不是某位学员——它影响整条链的归属", () => {
    const p = 提("update_channel", { channelName: "林老师（附中）", ownerName: "张沁", reason: "x" });
    const t = describeProposal(p, "学员");
    expect(t).toContain("渠道");
    expect(t).toContain("林老师（附中）");
    expect(t).not.toContain("学员「");
  });
});
