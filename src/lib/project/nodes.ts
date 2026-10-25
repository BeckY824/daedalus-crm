/**
 * 团队版项目模式 1a（2026-10-23，D-31）：项目的阶段、节点、结局，一套，内外贸不拆。
 * 存在 Project.phase / node / result 三列里（prisma/schema.prisma），这里是唯一的取值来源。
 *
 * 规矩（总控 10-23，按对方结论走）：
 *   - 节点不能往前跳：往前只能一步一步走（一个阶段的最后一个节点往前一步 = 下一阶段第一个节点）；
 *     往后退随便退到之前任何一个节点，跨阶段也行。每改一次记一行 ProjectNodeLog（lib/project/db.ts）
 *   - 签约审批就是一个普通节点，手动推
 *   - 「已转商机」「赢单」不是结局，是进下一阶段的第一个节点；真正的结局只有四个：线索流失、丢单、成功交付、异常状态
 *   - 成功交付：尾款结清、验收通过两项都勾上才让点
 *   - 线索流失、丢单：企业版要写一句原因（要原因 = 企业版()），记在节点变更里（10-25 F8）
 *   - 异常状态：从异常类别字典里选一个（默认纠纷取消、项目停滞，老板能加能停用），备注可写可不写；
 *     恢复 = 再改到某个节点（结局清掉），同样守上面的前后规矩
 */

export const 阶段们 = ["线索", "商机", "订单"] as const;
export type 阶段 = (typeof 阶段们)[number];

export const 节点们: Record<阶段, readonly string[]> = {
  线索: ["潜客培育", "线索验证", "线索推进"],
  商机: ["明确需求", "共识方案", "成交推进", "签约审批", "签订合同", "首款支付"],
  订单: ["生产备货", "物流运输", "安装实施", "验收交付", "尾款结算"],
};

/** 每个阶段走完的两条路：前一个进下一阶段（没有下一阶段的就是结局），后一个是没走成 */
export const 出口们: Record<阶段, readonly [string, string]> = {
  线索: ["已转商机", "线索流失"],
  商机: ["赢单", "丢单"],
  订单: ["成功交付", "异常状态"],
};

export const 结局们 = ["线索流失", "丢单", "成功交付", "异常状态"] as const;
export type 结局 = (typeof 结局们)[number];

export const 第一个节点 = { phase: "线索" as 阶段, node: 节点们.线索[0] };

export type 位置 = { phase: string; node: string; result?: string | null };

export function 是阶段(v: unknown): v is 阶段 {
  return typeof v === "string" && (阶段们 as readonly string[]).includes(v);
}

export function 是结局(v: unknown): v is 结局 {
  return typeof v === "string" && (结局们 as readonly string[]).includes(v);
}

/** 这个结局属于哪个阶段（结局只能在自己的阶段里点） */
export function 结局所在阶段(r: 结局): 阶段 {
  return r === "线索流失" ? "线索" : r === "丢单" ? "商机" : "订单";
}

/** 异常备注、没成原因最长多少字 */
export const 原因上限 = 500;

/** 点「线索流失 / 丢单」要写一句原因（10-25 企业版实测 F8：节点变更里原因不能空） */
export function 要写原因(r: unknown): r is "线索流失" | "丢单" {
  return r === "线索流失" || r === "丢单";
}

/** 成功交付还差哪几项；空 = 能点 */
export function 交付还差(p: { balanceSettled: boolean; acceptancePassed: boolean }): string[] {
  return [...(p.balanceSettled ? [] : ["尾款结清"]), ...(p.acceptancePassed ? [] : ["验收通过"])];
}

/**
 * 改到哪里合不合规矩：不合规矩返回一句人话，合规矩返回 null。
 * 不管「谁能改」、类别在不在字典里（那是 lib/project/db.ts 的事），只管取值、前后方向和两条门槛。
 * 项目 = 现在的位置 + 两个勾；往前比现在多走超过一步就不让。
 */
export function 改节点问题(
  到: 位置,
  项目: 位置 & { balanceSettled: boolean; acceptancePassed: boolean },
  异常?: { categoryId?: string | null; 备注?: string | null },
  要原因 = false,
): string | null {
  if (!是阶段(到.phase)) return `没有「${到.phase}」这个阶段`;
  if (!节点们[到.phase].includes(到.node)) return `「${到.phase}」阶段没有「${到.node}」这个节点`;
  if (节点序号(到) > 节点序号(项目) + 1) {
    const 下 = 下一步({ phase: 项目.phase, node: 项目.node });
    return 下 ? `节点不能往前跳，只能先推到「${下.node}」` : "节点不能往前跳";
  }
  const r = 到.result ?? null;
  if (r == null) return null;
  if (!是结局(r)) return `没有「${r}」这个结局`;
  if (结局所在阶段(r) !== 到.phase) return `「${r}」只能在${结局所在阶段(r)}阶段点`;
  if (要原因 && 要写原因(r)) {
    const 原因 = (异常?.备注 ?? "").trim();
    if (!原因) return `点「${r}」要写一句原因`;
    if (原因.length > 原因上限) return `原因请控制在 ${原因上限} 字以内`;
  }
  if (r === "成功交付") {
    const 差 = 交付还差(项目);
    if (差.length) return `还差${差.join("、")}，勾上才能点成功交付`;
  }
  if (r === "异常状态") {
    // 10-23 定：异常只在订单阶段有，线索、商机阶段的项目（哪怕下一步就进订单）都不能直接进异常
    if (项目.phase !== "订单") return "异常状态只在订单阶段能点";
    if (!异常?.categoryId) return "进异常状态要选一个异常类别";
    if ((异常.备注 ?? "").trim().length > 原因上限) return `备注请控制在 ${原因上限} 字以内`;
  }
  return null;
}

/**
 * 「往前推一步」落到哪：同阶段下一个节点；一个阶段的最后一个节点往前推，就是走「已转商机 / 赢单」进下一阶段第一个节点。
 * 订单最后一个节点没有下一步（只剩点结局），返回 null；已经有结局的也返回 null（先恢复再推）。
 */
export function 下一步(当前: 位置): { phase: 阶段; node: string } | null {
  if (当前.result || !是阶段(当前.phase)) return null;
  const 列 = 节点们[当前.phase];
  const i = 列.indexOf(当前.node);
  if (i < 0) return null;
  if (i < 列.length - 1) return { phase: 当前.phase, node: 列[i + 1] };
  const 下阶段 = 阶段们[阶段们.indexOf(当前.phase) + 1];
  return 下阶段 ? { phase: 下阶段, node: 节点们[下阶段][0] } : null;
}

/** 看板分哪几列：三个阶段里还在走的（异常状态留在订单列、标红，等人处理），加上成功交付、没成两列 */
export const 看板列们 = ["线索", "商机", "订单", "成功交付", "没成"] as const;
export type 看板列 = (typeof 看板列们)[number];

export function 看板列(p: 位置): 看板列 {
  if (p.result === "成功交付") return "成功交付";
  if (p.result === "线索流失" || p.result === "丢单") return "没成";
  return 是阶段(p.phase) ? p.phase : "线索";
}

/** 节点在整条路上排第几（从 0 起），进度条用；认不出的当 0 */
export function 节点序号(p: 位置): number {
  if (!是阶段(p.phase)) return 0;
  const 前面 = 阶段们.slice(0, 阶段们.indexOf(p.phase)).reduce((n, s) => n + 节点们[s].length, 0);
  return 前面 + Math.max(0, 节点们[p.phase].indexOf(p.node));
}

export const 节点总数 = 阶段们.reduce((n, s) => n + 节点们[s].length, 0);
