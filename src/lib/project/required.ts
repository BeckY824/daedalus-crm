/**
 * 企业版节点必填 + 自动推进（2026-10-24，D-37）：老板给节点配「必填哪几样」，填齐了项目自动往前推一步。
 * 这里只管目录和算「还差」（界面也引，不能碰 prisma）；读库、推进在 lib/project/db.ts 的 按必填推进。
 *
 * 规矩：
 *   - 没开、或一个节点都没配：和原来完全一样
 *   - 配了必填的节点：填齐了自动推到下一节点（同一步一步走的规矩），留一行节点变更，理由写明是自动推进；
 *     推到的下一个节点也配了、也已经齐了，接着推（一次可能走好几步）
 *   - 没填齐也能保存，只是不推；节点页上列「还差哪几样」
 *   - 配了必填的节点，手动往前推只给老板、主管（销售本人只能靠填齐）；往后退照旧
 *   - 退回到的节点不自动推（退回来一般是要重做，等上级手动推）；退回时已填的都留着
 *   - 没配必填的节点照原来：能管项目的人手动推，不自动推
 * 必填目录只用系统里已有的字段；方案附件、报价、定金这些还没有的字段，等清单定了再加
 */
import { 节点们 } from "./nodes";
import type { 组织规则 } from "./org-rules";

export const 必填项们 = [
  { key: "联系方式", 说明: "电话、WhatsApp、微信、邮箱、阿里国际站 ID 任一（客户或联系人上的都算）" },
  { key: "来源", 说明: "客户来源" },
  { key: "国家", 说明: "国家 / 地区" },
  { key: "客户等级", 说明: "A / B / C / D" },
  { key: "主联系人", 说明: "项目上选了主联系人" },
  { key: "需求", 说明: "写在项目的「备注」那一格（备注里写了需求就算）" },
  { key: "金额", 说明: "项目金额大于 0" },
  { key: "预计成交日期", 说明: "客户的预计签约时间" },
  { key: "下一步时间", 说明: "项目的下一步时间" },
  { key: "本节点沟通", 说明: "在这个节点上记过至少一条沟通" },
  { key: "验收通过", 说明: "「验收通过」打了勾" },
] as const;
export type 必填项 = (typeof 必填项们)[number]["key"];
export const 必填项名们: readonly string[] = 必填项们.map((x) => x.key);
/** 界面上的叫法：「需求」查的是项目备注，不写明白销售找不到在哪填（键名照旧，存在组织规则里） */
export const 必填叫法 = (k: string) => (k === "需求" ? "需求（项目备注）" : k);

/** 能配必填的节点：除了最后一个（尾款结算后面只剩点结局，由人点成功交付） */
const 全部节点 = [...节点们.线索, ...节点们.商机, ...节点们.订单];
export const 能配必填的节点: readonly string[] = 全部节点.slice(0, -1);

/**
 * 待确认清单① 的默认建议里、系统已有字段能对上的那几样；设置页「用建议清单」一键填上（部署手册写的默认配置就是这张）。
 * 签约审批、安装实施故意不设（人工推进 / 不需要安装的订单也得能过）；
 * 签订合同、首款支付、生产备货、物流运输要的合同、首款、采购单、物流单据系统里还没有，等清单定了加字段再配
 */
export const 建议必填: Record<string, 必填项[]> = {
  潜客培育: ["联系方式", "来源", "本节点沟通", "下一步时间"],
  线索验证: ["主联系人", "国家", "客户等级", "需求"],
  线索推进: ["金额"],
  明确需求: ["需求", "预计成交日期", "主联系人"],
  共识方案: ["下一步时间", "本节点沟通"],
  成交推进: ["金额", "预计成交日期"],
  验收交付: ["验收通过"],
};

/** 算还差时要的数据（db.ts 读好传进来） */
export type 必填数据 = {
  项目: { node: string; contactId: string | null; nextStepAt: Date | string | null; amount: number; remark: string | null; acceptancePassed: boolean };
  客户: {
    phone: string | null;
    expectedSignAt: Date | string | null;
    extra: { country?: string | null; whatsapp?: string | null; wechat?: string | null; email?: string | null; source?: string | null; level?: string | null; alibabaId?: string | null } | null;
  };
  联系人们: { phone?: string | null; email?: string | null; wechat?: string | null }[];
  /** 挂在项目上的沟通各在哪个节点记的 */
  沟通节点们: string[];
};

const 有 = (v: string | null | undefined) => !!v && v.trim().length > 0;

function 齐了(项: 必填项, d: 必填数据): boolean {
  const x = d.客户.extra;
  switch (项) {
    case "联系方式":
      return 有(d.客户.phone) || 有(x?.whatsapp) || 有(x?.wechat) || 有(x?.email) || 有(x?.alibabaId)
        || d.联系人们.some((c) => 有(c.phone) || 有(c.email) || 有(c.wechat));
    case "来源": return 有(x?.source);
    case "国家": return 有(x?.country);
    case "客户等级": return 有(x?.level);
    case "主联系人": return !!d.项目.contactId;
    case "需求": return 有(d.项目.remark);
    case "金额": return d.项目.amount > 0;
    case "预计成交日期": return !!d.客户.expectedSignAt;
    case "下一步时间": return !!d.项目.nextStepAt;
    case "本节点沟通": return d.沟通节点们.includes(d.项目.node);
    case "验收通过": return d.项目.acceptancePassed;
  }
}

/** 这个节点配了哪几样（没开 = 空） */
export function 节点必填(规则: 组织规则, node: string): 必填项[] {
  if (!规则.节点推进.开) return [];
  return (规则.节点推进.必填[node] ?? []) as 必填项[];
}

/** 开了、至少一个节点配了：才按新规矩走（读库、拦手动推进） */
export function 节点推进生效(规则: 组织规则): boolean {
  return 规则.节点推进.开 && Object.values(规则.节点推进.必填).some((l) => l.length > 0);
}

/** 现在这个节点还差哪几样（按配的顺序）；空 = 齐了。没配的节点永远空 */
export function 还差(规则: 组织规则, d: 必填数据): 必填项[] {
  return 节点必填(规则, d.项目.node).filter((项) => !齐了(项, d));
}

/** 这个节点按必填走：开了、配了至少一样 */
export function 按必填走(规则: 组织规则, node: string): boolean {
  return 节点必填(规则, node).length > 0;
}

/** 来源、国家、客户等级记在外贸档案里，不是外贸模板的客户页没这几格，提示了也补不上 */
const 只外贸有: readonly 必填项[] = ["来源", "国家", "客户等级"];

/**
 * 团队版节点「建议补上」（10-28，照企业版 09b59016 节点必填，团队版只提示）：
 * 没有后台配置，直接按 建议必填 这张表算；不拦手动推进、不自动推进，只在节点下面列一行。
 * 不是外贸模板的，外贸档案里那几样不提。空 = 这个节点没什么要补的
 */
export function 建议还差(d: 必填数据, 外贸: boolean): 必填项[] {
  return (建议必填[d.项目.node] ?? []).filter((项) => (外贸 || !只外贸有.includes(项)) && !齐了(项, d));
}
