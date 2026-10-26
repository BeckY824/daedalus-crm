/**
 * 企业版超时回收 · 夜里定时扫（Q-13，2026-10-25）：每天 00:05 扫一次，夜里没人打开页面也照收。
 *
 * 收法和打开项目列表 / 首页时那次是同一个函数（db.ts 公海超时收回）：同一套规则、同一个「今天按这份规则扫过了」的记号，
 * 所以夜里扫过，白天打开页面不再收；同一天跑几遍也只收一次。
 *
 *   - 只在企业版起钟（instrumentation.ts）；项目模式关着不扫
 *   - 每分钟看一眼钟，过了今天 00:05 才扫（服务器停着错过了，开机就补）
 *   - 留痕、操作日志记在「系统」名下（timeout.ts 系统，QA #16）；一个在职老板都没有就不扫，等有人打开页面
 */
import { prisma } from "../prisma";
import { getBusiness } from "../business";
import { 企业版 } from "@/lib/enterprise/switch";
import { 公海超时收回 } from "./db";
import { dayjs } from "../utils";

export const 夜扫时刻 = { 时: 0, 分: 5 } as const;

/** 今天过了 00:05 没（服务器时间） */
export function 过了夜扫时刻(现在: Date): boolean {
  return !dayjs(现在).isBefore(dayjs(现在).startOf("day").hour(夜扫时刻.时).minute(夜扫时刻.分));
}

/** 扫一遍：到点了、企业版、项目模式开着才真收。返回收回了几个 */
export async function 夜里扫超时(现在: Date = new Date()): Promise<number> {
  if (!企业版() || !过了夜扫时刻(现在)) return 0;
  if ((await getBusiness()).projectMode !== true) return 0;
  const 老板 = await prisma.user.findFirst({
    where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true },
  });
  if (!老板) return 0;
  return 公海超时收回(老板, 现在);
}

const g = globalThis as unknown as { __entNightlyTimer?: ReturnType<typeof setInterval>; __entNightlyRun?: Promise<void> };

/** 钟上正在跑的那一遍（测试等它跑完；上一遍没完不叠） */
export function 夜扫在跑(): Promise<void> | undefined {
  return g.__entNightlyRun;
}

/** 起钟（instrumentation.ts 调；开发时热更新重复调只起一个） */
export function 启动夜扫(间隔毫秒 = 60_000): void {
  if (!企业版() || g.__entNightlyTimer) return;
  g.__entNightlyTimer = setInterval(() => {
    if (g.__entNightlyRun) return;
    g.__entNightlyRun = 夜里扫超时()
      .then(() => undefined, (e) => console.error("[超时回收] 夜里扫的时候出错，下一分钟再试", e))
      .finally(() => { g.__entNightlyRun = undefined; });
  }, 间隔毫秒);
  g.__entNightlyTimer.unref?.();
}

/** 停钟（测试用） */
export function 停夜扫(): void {
  if (g.__entNightlyTimer) clearInterval(g.__entNightlyTimer);
  g.__entNightlyTimer = undefined;
}
