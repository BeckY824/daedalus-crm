/**
 * 企业版节点必填（lib/project/required.ts，D-37）：没开 / 没配的节点永远不差；配了的按数据算还差哪几样。
 */
import { describe, it, expect } from "vitest";
import { 还差, 节点推进生效, 按必填走, 节点必填, 能配必填的节点, 建议必填, 必填项名们, 建议还差, type 必填数据 } from "@/lib/project/required";
import { 默认组织规则, type 组织规则 } from "@/lib/project/org-rules";

const 规则 = (必填: Record<string, string[]>, 开 = true): 组织规则 => ({ ...默认组织规则, 节点推进: { 开, 必填 } });

const 空数据 = (node = "潜客培育"): 必填数据 => ({
  项目: { node, contactId: null, nextStepAt: null, amount: 0, remark: null, acceptancePassed: false },
  客户: { phone: null, expectedSignAt: null, extra: null },
  联系人们: [],
  沟通节点们: [],
});

describe("目录", () => {
  it("最后一个节点不能配；建议清单只用目录里有的、能配的节点", () => {
    expect(能配必填的节点).not.toContain("尾款结算");
    expect(能配必填的节点).toContain("验收交付");
    for (const [node, 项] of Object.entries(建议必填)) {
      expect(能配必填的节点).toContain(node);
      for (const x of 项) expect(必填项名们).toContain(x);
    }
  });
  it("建议清单 = 部署手册里的默认配置：签约审批、安装实施留空；合同、首款、备货、物流四个节点缺字段，先不配", () => {
    expect(Object.keys(建议必填)).toEqual(["潜客培育", "线索验证", "线索推进", "明确需求", "共识方案", "成交推进", "验收交付"]);
    for (const 不配 of ["签约审批", "签订合同", "首款支付", "生产备货", "物流运输", "安装实施"]) expect(建议必填[不配]).toBeUndefined();
  });
});

describe("生效 / 按必填走", () => {
  it("没开：哪怕配了也当没配", () => {
    const r = 规则({ 潜客培育: ["来源"] }, false);
    expect(节点推进生效(r)).toBe(false);
    expect(按必填走(r, "潜客培育")).toBe(false);
    expect(节点必填(r, "潜客培育")).toEqual([]);
    expect(还差(r, 空数据())).toEqual([]);
  });

  it("开了但一个都没配：不生效", () => {
    expect(节点推进生效(规则({}))).toBe(false);
    expect(节点推进生效(默认组织规则)).toBe(false);
  });

  it("开了、配了：只有配了的节点按必填走", () => {
    const r = 规则({ 潜客培育: ["来源"] });
    expect(节点推进生效(r)).toBe(true);
    expect(按必填走(r, "潜客培育")).toBe(true);
    expect(按必填走(r, "线索验证")).toBe(false);
    expect(还差(r, 空数据("线索验证"))).toEqual([]);
  });
});

describe("还差", () => {
  const 全部 = 规则({ 潜客培育: [...必填项名们] });

  it("什么都没填：按配的顺序全列出来", () => {
    expect(还差(全部, 空数据())).toEqual([...必填项名们]);
  });

  it("都填了：空", () => {
    const d: 必填数据 = {
      项目: { node: "潜客培育", contactId: "c1", nextStepAt: new Date(), amount: 100, remark: "要 200 台", acceptancePassed: true },
      客户: { phone: null, expectedSignAt: "2026-11-30", extra: { country: "德国", source: "展会", level: "A" } },
      联系人们: [{ email: "a@b.com" }],
      沟通节点们: ["潜客培育"],
    };
    expect(还差(全部, d)).toEqual([]);
  });

  it("联系方式：客户上任一样、或任一联系人的电话 / 邮箱 / 微信都算；空白不算", () => {
    const r = 规则({ 潜客培育: ["联系方式"] });
    expect(还差(r, 空数据())).toEqual(["联系方式"]);
    expect(还差(r, { ...空数据(), 客户: { phone: "  ", expectedSignAt: null, extra: { whatsapp: "" } } })).toEqual(["联系方式"]);
    for (const extra of [{ whatsapp: "+49" }, { wechat: "w" }, { email: "e" }, { alibabaId: "x" }]) {
      expect(还差(r, { ...空数据(), 客户: { phone: null, expectedSignAt: null, extra } })).toEqual([]);
    }
    expect(还差(r, { ...空数据(), 客户: { phone: "138", expectedSignAt: null, extra: null } })).toEqual([]);
    expect(还差(r, { ...空数据(), 联系人们: [{ phone: "" }, { wechat: "w" }] })).toEqual([]);
  });

  it("金额要大于 0；需求空白不算；本节点沟通只认这个节点记的", () => {
    const r = 规则({ 线索验证: ["金额", "需求", "本节点沟通"] });
    const d = 空数据("线索验证");
    d.项目.remark = "   ";
    d.沟通节点们 = ["潜客培育"];
    expect(还差(r, d)).toEqual(["金额", "需求", "本节点沟通"]);
    d.项目.amount = 1;
    d.项目.remark = "要样品";
    d.沟通节点们.push("线索验证");
    expect(还差(r, d)).toEqual([]);
  });
});

describe("团队版 建议还差（只提示）", () => {
  it("外贸模板：照建议清单列出还差的", () => {
    expect(建议还差(空数据("潜客培育"), true)).toEqual(["联系方式", "来源", "本节点沟通", "下一步时间"]);
    expect(建议还差(空数据("线索验证"), true)).toEqual(["主联系人", "国家", "客户等级", "需求"]);
  });

  it("不是外贸模板：外贸档案里的来源、国家、客户等级不提", () => {
    expect(建议还差(空数据("潜客培育"), false)).toEqual(["联系方式", "本节点沟通", "下一步时间"]);
    expect(建议还差(空数据("线索验证"), false)).toEqual(["主联系人", "需求"]);
  });

  it("填齐了、或清单里没有的节点：空", () => {
    const d = 空数据("线索推进");
    expect(建议还差({ ...d, 项目: { ...d.项目, amount: 1 } }, false)).toEqual([]);
    expect(建议还差(空数据("尾款结算"), true)).toEqual([]);
  });
});
