/**
 * 企业版组织规则的开关表（2026-10-24）。
 *
 * 每条规则一个 Setting 开关，默认关；生效 = 企业版() 开着 **且** 自己的开关开着。
 * 开关存在租户库 Setting 表（值是 JSON true / false），设置 → 组织架构里由老板、总管理员拨。
 *
 * 规则表本身在 rules-table.ts（纯数据，设置页客户端组件 import 那个）；这里只多一个读开关的 规则开着。
 * visibility.ts 在 Prisma 钩子里用这张表，别在顶层 import prisma，带上就绕回自己了。
 */
import { 企业版 } from "./switch";
import { 规则, type 规则名 } from "./rules-table";

export * from "./rules-table";

/** 规则现在生不生效（服务端用；钩子里别调，钩子里直接读 Setting 行） */
export async function 规则开着(名: 规则名): Promise<boolean> {
  if (!企业版()) return false;
  const { getSetting } = await import("@/lib/settings");
  return (await getSetting<boolean>(规则[名].key)) === true;
}
