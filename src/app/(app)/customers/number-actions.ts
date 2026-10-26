"use server";

/**
 * 企业版建档向导的「查重」按钮（2026-10-26，测试清单 B2–B8）：选号码类型 → 验格式 → 全公司查重，回一句对方系统原样的提示。
 * 规矩在 lib/enterprise/contact-format.ts，查重在 lib/enterprise/contact-dedupe.ts；保存时 saveCustomer 再按同一套挡一次。
 * 手机号顺带回归属地（B7，lib/enterprise/phone-region.ts，离线）。
 * 开关关着不认（向导也不显示类型下拉，照旧走 checkDuplicate）
 */
import { requireUser } from "@/lib/auth";
import { prisma, defaultClient } from "@/lib/prisma";
import { 读的我 } from "@/lib/team-scope";
import { 企业版 } from "@/lib/enterprise/switch";
import { 验号码 } from "@/lib/enterprise/contact-format";
import { 企业号码查重, type 撞到的人 } from "@/lib/enterprise/contact-dedupe";
import { 号码归属地 } from "@/lib/enterprise/phone-region";

export type 查号码结果 =
  /** 没过格式：未选类型 / 无法识别 / 格式错误 / 待上传 */
  | { ok: false; 状态: string; 提示: string }
  /**
   * 值 = 规整后的号码（手机号去掉 +86 和分隔符），向导拿去填联系人那一格。
   * 归属地 = 只有手机号有（B7）：国内「广东 深圳 中国移动」、国外「英国」；离线表里查不到、别的类型都是 null
   */
  | { ok: true; 状态: "首次录入" | "公海待捞" | "我的通讯录已有" | "重复"; 提示: string; 值: string; 撞: 撞到的人 | null; 归属地: string | null };

export async function 查号码(类型: string, 值: string): Promise<查号码结果> {
  const me = await requireUser();
  if (!企业版()) return { ok: false, 状态: "没开", 提示: "企业版才有号码类型" };
  const 号 = 验号码(类型, 值);
  if (!号.ok) return { ok: false, 状态: 号.状态, 提示: 号.提示 };
  const 结论 = await 企业号码查重(prisma, 号, me.id, await 读的我(defaultClient));
  return { ok: true, 状态: 结论.状态, 提示: 结论.提示, 值: 号.值, 撞: 结论.撞, 归属地: 号码归属地(号.类型, 号.值)?.文字 ?? null };
}
