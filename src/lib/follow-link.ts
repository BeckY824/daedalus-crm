/**
 * 跟进表单「关联商机 / 订单」那一格（2026-10-05 外贸客户建议）：一格两组，选订单存的是「订单:<id>」。
 * 从表单组件里挪出来好单测（2026-10-06 回归核对 W-012）。
 */
/** 「关联商机 / 订单」那一格里订单的值带这个前缀，商机的是光 id */
export const 订单前缀 = "订单:";

/**
 * 那一格的值拆成 opportunityId / orderId。不挂订单的模版不交 orderId（= 不碰，老记录挂着的订单原样留着）；
 * 挂订单的模版里选了商机就把订单摘掉、选了订单就不挂商机——一条跟进说的是一件事
 */
export function 拆关联(v: string | undefined | null, 挂订单: boolean, 原商机: string | null = null): { opportunityId: string | null; orderId?: string | null } {
  if (!挂订单) return { opportunityId: v ?? null };
  // 选的是订单：原来挂着的商机留着（订单页上记的那几条两样都挂着，编辑一下别把商机悄悄摘掉，2026-10-05 复查）
  if (v && v.startsWith(订单前缀)) return { opportunityId: 原商机, orderId: v.slice(订单前缀.length) };
  return { opportunityId: v ?? null, orderId: null };
}

