"use client";

import { createContext, useContext } from "react";

/**
 * 当前登录的人（客户端组件用）。外壳（AppShell）放进来。
 *
 * 2026-10-03 团队同步之后才需要它：原来桌面端一个库就一个人，新建时「负责人」那一格不问（lib/utils.ts 独自一人），
 * 服务端填成那唯一的人；进了团队，同事的账号也同步进来了，表单开始问负责人——默认值得是「我」，
 * 不能是候选里排第一的那位同事（不然我建的客户默认记到别人名下）。
 */
const Ctx = createContext<{ id: string; name: string } | null>(null);

export const 我Provider = Ctx.Provider;

export function useMe(): { id: string; name: string } | null {
  return useContext(Ctx);
}

/** 新建时负责人那一格的默认：我在候选里就是我，不在（比如管理员不做销售）就留空让人选 */
export function 默认负责人(我: { id: string } | null, 候选: { id: string }[]): string | undefined {
  return 我 && 候选.some((u) => u.id === 我.id) ? 我.id : undefined;
}
