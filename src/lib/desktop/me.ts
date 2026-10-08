/**
 * 这台电脑上的「我」是业务库里哪个 User（2026-10-03，团队同步之后要分清）。
 *
 * 原来一律取「第一个在职管理员」：一个人的库里只有他一个管理员，对。
 * 进了团队之后，同事的账号也同步进来了，而且他们也是管理员——再按「第一个」取，
 * 自动登录、Dock 提醒、名字对齐就可能落到别人头上。
 * 进团队时本机的管理员改了身份，id 是 `acct_<云端账号 id>`（lib/sync/local.ts 改身份）：有这一行就是它，
 * 没有（没开团队）照旧取第一个在职管理员。desktop/server-entry.js 启动时对名字用的是同一条规则。
 */
import type { PrismaClient } from "@/generated/prisma";
import { 读 as 读云端凭据 } from "./cloud";

export const 团队身份id = (accountId: string) => `acct_${accountId}`;

export async function 本机我(db: PrismaClient): Promise<{ id: string } | null> {
  const 账号 = 读云端凭据()?.accountId;
  if (账号) {
    const 我 = await db.user.findUnique({ where: { id: 团队身份id(账号) }, select: { id: true, active: true } });
    /*
      有这一行但被停用了（老板在「设置 → 团队成员」里停用了他，active 会同步过来）：就是没有「我」。
      不能退回「第一个在职管理员」——团队里那是老板那一行：他会被自动登录成老板，
      启动时还会把老板的名字改成他的、同步给全队（2026-10-08 发版前审查）
    */
    if (我) return 我.active ? { id: 我.id } : null;
  }
  return db.user.findFirst({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
}

/** 本机我() 为空是因为团队里的这一行被停用了（登录页要说清楚，不是「库坏了」） */
export async function 团队里被停用(db: PrismaClient): Promise<boolean> {
  const 账号 = 读云端凭据()?.accountId;
  if (!账号) return false;
  const 我 = await db.user.findUnique({ where: { id: 团队身份id(账号) }, select: { active: true } });
  return !!我 && !我.active;
}
