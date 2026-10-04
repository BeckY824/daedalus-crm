/**
 * 「先查重、再写入」落进同一个事务（2026-10-04 J-104）。
 *
 * 两个窗口几乎同时提交同一件事——同日同额的签约、同一个号码的新客户、同一份表导两次——
 * 原来都是「查一下没有 → 写」两步分开走：两边的「查」都落在对方的「写」之前，于是都查不到、都写进去，
 * 业绩翻倍、同号两份档案。界面上的提示只是给人看的，挡不住这种。
 *
 * 为什么不加唯一索引：手机号刻意不唯一（家长学生共用号码，2026-08-29 决策；老库里也真有同号的几条，
 * 建唯一索引会让老库迁移失败），签约「同日同额」更不是唯一——续费、分期就是同额同日，确认后照录。
 * 所以闸门只能是「查和写之间没有缝」：SQLite 的写事务是独占的，同一个进程里 Prisma 的交互式事务
 * 一个接一个跑（tests/check-then-write.test.ts 钉着），后进来的那个查的时候先进来的已经写完了。
 *
 * 另一个进程同时写（少见：桌面端只有一个本地服务）时 SQLite 会回「库忙」或写冲突，那一次什么都没写进去，
 * 整段重来即可，几轮拿不下就照常抛出去。
 *
 * **事务里只用 tx**：在里面走外面的 prisma 写，要排在这个事务后面等它提交（等到 busy_timeout）；
 * 走外面读，看不到事务里还没提交的那几行。要的配置（getBusiness 之类）先在外面读好。
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";

/** 「库忙 / 写冲突」：这一轮什么都没写进去，可以整段重来 */
function 撞上别的写入(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === "P2034") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /database is locked|SQLITE_BUSY/i.test(msg);
}

export async function 查完再写<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let 第几轮 = 1; ; 第几轮++) {
    try {
      // 排队等前一个事务的时间放宽：默认 2 秒，前面恰好有一段同步回放时会误报失败
      return await prisma.$transaction(fn, { maxWait: 10_000, timeout: 15_000 });
    } catch (e) {
      if (第几轮 >= 3 || !撞上别的写入(e)) throw e;
      await new Promise((r) => setTimeout(r, 30 * 第几轮));
    }
  }
}
