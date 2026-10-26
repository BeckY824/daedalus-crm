/**
 * 企业版「后台设置谁能改」的读库部分；表和判断在 edit-perm-table.ts（设置页客户端组件 import 那个），这里 re-export。
 *
 * 不是企业版：照原来只有老板能改，不看这张表。
 */
import { 改权限key, 规整改权限, 能改设置, 谁能改的话, type 改权限配置, type 设置项名 } from "./edit-perm-table";

export * from "./edit-perm-table";

export async function 读改权限(): Promise<改权限配置> {
  const { getSetting } = await import("@/lib/settings");
  return 规整改权限(await getSetting<unknown>(改权限key));
}

/** 我能不能改这一项：能 = null，不能 = 那句「只有……能改」 */
export async function 挡改设置(me: { id: string; role: string }, 项: 设置项名, 目标?: string): Promise<string | null> {
  const { 企业版 } = await import("./switch");
  if (!企业版()) return me.role === "ADMIN" ? null : "只有老板能改";
  const 配置 = await 读改权限();
  const { 读组织 } = await import("./org");
  return 能改设置(await 读组织(), me, 项, 配置, 目标) ? null : 谁能改的话(配置, 项);
}
