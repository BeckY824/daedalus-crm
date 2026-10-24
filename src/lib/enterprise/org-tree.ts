/**
 * 企业版部门树（2026-10-24）：设置页的客户端组件也用，所以这里只放纯类型和纯函数，
 * 别 import prisma 或任何只能在服务端跑的东西——不然客户端打包会带上 node:fs 等直接失败。
 */

export type 组织部门 = { id: string; name: string; parentId: string | null; sort: number };

/** 部门排成一棵树给界面画：先父后子、同级按 sort 再按名字；断链、成环的放最后当一级，标 断 */
export function 部门树(部门: readonly 组织部门[]): { d: 组织部门; 层: number; 断: boolean }[] {
  const 子 = new Map<string, 组织部门[]>();
  for (const d of 部门) if (d.parentId) 子.set(d.parentId, [...(子.get(d.parentId) ?? []), d]);
  const 排 = (xs: 组织部门[]) => [...xs].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "zh"));
  const 出 = new Map<string, { d: 组织部门; 层: number; 断: boolean }>();
  const 走 = (d: 组织部门, 层: number, 断: boolean) => {
    if (出.has(d.id)) return;
    出.set(d.id, { d, 层, 断 });
    for (const c of 排(子.get(d.id) ?? [])) 走(c, 层 + 1, false);
  };
  for (const d of 排(部门.filter((x) => !x.parentId))) 走(d, 1, false);
  for (const d of 排(部门.filter((x) => !出.has(x.id)))) 走(d, 1, true);
  return [...出.values()];
}
