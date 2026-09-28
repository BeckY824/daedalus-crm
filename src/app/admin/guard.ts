import { timingSafeEqual } from "node:crypto";
import { notFound } from "next/navigation";
import { multiTenant } from "@/lib/tenant/context";
import { 当前运营账号 } from "@/lib/ops-auth";

/**
 * 运营台每一页的门。认两样：网址上的口令（?token=，open-admin.sh 那条路），
 * 或者从桌面端进来时下发的运营台票（cookie，见 lib/ops-auth.ts）。两样都没有一律 404——
 * **连外壳都不画**：导航长什么样、有几页，对拿不到口令的人来说都不该存在。
 *
 * 没配 ADMIN_TOKEN、或者不是托管版（自部署的开源版）：整个运营台当不存在，
 * 免得自部署的人暴露一个无保护的后台。和 actions.ts 的 guard 同一套判断——
 * 页面进得来不代表动作能调，那边每个动作还会再验一遍。
 */
export async function 验口令(sp: Promise<{ token?: string }>): Promise<string> {
  if (!multiTenant()) notFound();
  const given = (await sp).token ?? "";
  if (口令对(given)) return given;
  /*
    或者带着运营台票（从桌面端「运营台…」进来的，见 lib/ops-auth.ts）。
    这时返回空串：页面上的链接和动作就不带口令，网址上也不会出现它。
  */
  if (await 当前运营账号()) return "";
  notFound();
}

/** ADMIN_TOKEN 对不对。没配 ADMIN_TOKEN 就永远不对（不是永远对） */
export function 口令对(given: string): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 顶上那个环境标记：这几页对着的是线上库，一个动作就能停掉别人的工作区 */
export function 环境(): "生产" | "本地" {
  return process.env.NODE_ENV === "production" ? "生产" : "本地";
}
