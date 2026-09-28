import { timingSafeEqual } from "node:crypto";
import { notFound } from "next/navigation";
import { multiTenant } from "@/lib/tenant/context";

/**
 * 运营台每一页的门。口令在网址上（?token=），不对一律 404——
 * **连外壳都不画**：导航长什么样、有几页，对拿不到口令的人来说都不该存在。
 *
 * 没配 ADMIN_TOKEN、或者不是托管版（自部署的开源版）：整个运营台当不存在，
 * 免得自部署的人暴露一个无保护的后台。和 actions.ts 的 guard 同一套判断——
 * 页面进得来不代表动作能调，那边每个动作还会再验一遍。
 */
export async function 验口令(sp: Promise<{ token?: string }>): Promise<string> {
  const expected = process.env.ADMIN_TOKEN;
  const given = (await sp).token ?? "";
  if (!multiTenant() || !expected) notFound();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) notFound();
  return given;
}

/** 顶上那个环境标记：这几页对着的是线上库，一个动作就能停掉别人的工作区 */
export function 环境(): "生产" | "本地" {
  return process.env.NODE_ENV === "production" ? "生产" : "本地";
}
