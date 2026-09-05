/**
 * 五人同时在线的极限跑。
 *
 * 只关心一件事：SQLite 在多写并发下会不会抛 "database is locked"。
 * 这套系统跑在单文件 SQLite 上，写操作是全库串行的；WAL 模式让读写互不阻塞，
 * busy_timeout=5000 给抢不到锁的连接一个等待窗口。这两项配置一旦被改掉或失效，
 * 表现就是销售在保存的瞬间随机报错，而且很难复现——所以要有一条用例长期盯着。
 *
 * 每个「人」做的是真实动作的混合：建档、录跟进、改资料、批量改状态、翻列表，
 * 而不是单纯狂写一张表——只压一种写法压不出真实的锁竞争。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "压测", email: "s@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveCustomer, bulkFollowStatus } from "@/app/(app)/customers/actions";
import { saveFollowUp } from "@/app/(app)/customers/[id]/actions";

const 人数 = 5;
const 每人轮数 = 8;

let 销售: { id: string }[] = [];

beforeEach(async () => {
  await resetDb();

  销售 = [];
  for (let i = 0; i < 人数; i++) {
    销售.push(await prisma.user.create({
      data: { email: `u${i}`, name: `销售${i}`, title: "销售", role: "SALES", password: "x" },
    }));
  }
  mocks.user = { id: 销售[0].id, name: "压测", email: "s@x", role: "ADMIN", title: "管理员", avatar: null };
});

afterAll(async () => { await prisma.$disconnect(); });

/** 把锁相关的报错单独挑出来——其余业务性失败不算问题 */
function 锁报错(errs: unknown[]) {
  return errs.filter((e) => /database is locked|SQLITE_BUSY|busy/i.test(String(e)));
}

describe("五人同时在线", () => {
  it(`${人数} 人各做 ${每人轮数} 轮真实操作，不应出现 database is locked`, async () => {
    const 报错: unknown[] = [];

    async function 一个人干活(idx: number) {
      for (let r = 0; r < 每人轮数; r++) {
        try {
          const 建档 = await saveCustomer({
            name: `压测${idx}-${r}`,
            phone: `137${String(idx)}${String(r).padStart(2, "0")}0000`.slice(0, 11),
            school: null, grade: null, major: null,
            followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null,
            remark: null, salesOwnerId: 销售[idx].id, channelId: null, referrerCustomerId: null,
          });
          if (!建档.ok) throw new Error("建档失败：" + 建档.error);

          await saveFollowUp({
            customerId: 建档.id, type: "PHONE", title: `第 ${r} 通电话`, content: "沟通记录",
            status: "已完成", occurredAt: new Date().toISOString(),
          });

          const 行 = await prisma.customer.findUniqueOrThrow({ where: { id: 建档.id } });
          await saveCustomer({
            id: 建档.id,
            updatedAt: 行.updatedAt.toISOString(),
            base: {
              name: 行.name, phone: 行.phone, school: 行.school, grade: 行.grade, major: 行.major,
              followStatus: 行.followStatus, decisionStatus: 行.decisionStatus,
              expectedSignAt: 行.expectedSignAt, remark: 行.remark, salesOwnerId: 行.salesOwnerId,
              channelId: 行.channelId, referrerCustomerId: 行.referrerCustomerId,
            },
            name: 行.name, phone: 行.phone, school: "北京大学", grade: null, major: null,
            followStatus: "跟进中", decisionStatus: 行.decisionStatus, expectedSignAt: null,
            remark: null, salesOwnerId: 行.salesOwnerId, channelId: null, referrerCustomerId: null,
          });

          // 读操作混进来：WAL 模式下读不该被写阻塞
          await prisma.customer.findMany({ take: 20, orderBy: { createdAt: "desc" } });
        } catch (e) {
          报错.push(e);
        }
      }
    }

    await Promise.all(Array.from({ length: 人数 }, (_, i) => 一个人干活(i)));

    expect(锁报错(报错), "出现了 SQLite 锁冲突").toHaveLength(0);
    expect(报错, "并发过程中有非预期的失败").toHaveLength(0);
    expect(await prisma.customer.count()).toBe(人数 * 每人轮数);
    expect(await prisma.followUp.count()).toBe(人数 * 每人轮数);
  });

  it("五人同时对同一批学员做批量改状态，不应互相锁死", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await saveCustomer({
        name: `批量${i}`, phone: `13600000${String(i).padStart(3, "0")}`,
        school: null, grade: null, major: null,
        followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null,
        remark: null, salesOwnerId: 销售[0].id, channelId: null, referrerCustomerId: null,
      });
      if (!r.ok) throw new Error(r.error);
      ids.push(r.id);
    }

    const 状态 = ["跟进中", "已加微信", "已试听", "意向较高", "暂缓跟进"];
    const 结果 = await Promise.allSettled(状态.map((s) => bulkFollowStatus(ids, s)));
    const 失败 = 结果.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason);

    expect(锁报错(失败), "批量操作撞上了 SQLite 锁").toHaveLength(0);
    expect(失败).toHaveLength(0);
    // 最后所有人应落在同一个状态上——批量是全表串行写，不该出现半批
    const 分布 = await prisma.customer.groupBy({ by: ["followStatus"], _count: true });
    expect(分布).toHaveLength(1);
    expect(分布[0]._count).toBe(10);
  });

  it("WAL 与 busy_timeout 必须是生效的——配置被改掉时这条会先红", async () => {
    const [journal] = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode");
    const [timeout] = await prisma.$queryRawUnsafe<{ timeout: number }[]>("PRAGMA busy_timeout");
    expect(String(journal.journal_mode).toLowerCase()).toBe("wal");
    expect(Number(timeout.timeout)).toBeGreaterThanOrEqual(5000);
  });
});
