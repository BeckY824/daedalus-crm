import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { 算提醒 } from "@/lib/reminders";
import { 取提醒项, 取订单提醒项 } from "@/lib/reminders-db";
import { 归属对不上, 读 as 读云端凭据 } from "@/lib/desktop/cloud";
import { 本机我 } from "@/lib/desktop/me";

export const dynamic = "force-dynamic";

/**
 * 桌面端的壳每分钟问一次：Dock 上写几、早上那条汇总说什么、有没有到点的计划。
 *
 * **只有壳能问**：认的是本地服务启动时壳现生成的那枚令牌（DESKTOP_TOKEN，
 * 只在父子进程的环境变量里，不落盘），和 /api/desktop/session 是同一把钥匙、同一种比较法。
 * 不走会话 cookie——窗口关了壳照样要问（Mac 上关了窗口应用还在 Dock 里），那时没有页面、也没有 cookie。
 *
 * 不是桌面端本地模式（自部署、托管版）整个 404：这条路只属于那一台机器上的那一个人。
 *
 * 算谁的：和自动登录签会话的是同一个人——业务库里第一个在职管理员，本地模式下他就是登录的那个云端账号。
 * 口径和「跟进计划」页的「我的」一致，见 lib/reminders.ts。
 */
export async function GET(req: Request) {
  const expected = process.env.DESKTOP_TOKEN;
  if (process.env.DESKTOP_LOCAL !== "1" || !expected) return new NextResponse("Not Found", { status: 404 });

  const a = Buffer.from(req.headers.get("x-desktop-token") ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new NextResponse("Forbidden", { status: 403 });

  /*
    没登录云端账号、或者这个目录还是上一个账号的：什么都不报。
    Dock 上挂着一个上一个人的数、或者登录页后面弹一条「今天有 3 个要跟进」，都是在替别人说话。
  */
  if (归属对不上() || !读云端凭据()) return NextResponse.json({ 逾期: 0, 今天: 0, 定时: [], 最久: null, 订单: { 超期: 0, 今天: 0, 最久: null } });

  const 我 = await 本机我(prisma);
  if (!我) return NextResponse.json({ 逾期: 0, 今天: 0, 定时: [], 最久: null, 订单: { 超期: 0, 今天: 0, 最久: null } });

  const [项, 订单项] = await Promise.all([取提醒项(我.id), 取订单提醒项(我.id)]);
  return NextResponse.json(算提醒(项, new Date(), 订单项));
}
