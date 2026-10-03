/**
 * 第六轮对抗复查：左栏「收藏的客户」（app/(app)/favorites.ts、lib/favorites.ts）。
 *
 * 收藏只存 id，读的时候把删掉的滤掉——但上限 8 是按**存着的 id**算的，不是按还在的客户算的。
 * 删掉的客户一直占着名额，新收藏一位就把最早那位**还在的**挤掉。红的保持红。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

beforeEach(async () => {
  await resetDb();
  await prisma.user.create({ data: { id: "tester-id", email: "t", name: "测试员", title: "", role: "ADMIN", password: "x" } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function 造(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push((await prisma.customer.create({ data: { name: `客户${i}`, phone: `1380000${String(i).padStart(4, "0")}`, salesOwnerId: "tester-id" } })).id);
  }
  return ids;
}

describe("R6-6 删掉的客户还占着收藏名额", () => {
  it("收满 8 位、删掉 3 位（左栏剩 5 位），再收 1 位：左栏应是 6 位，实际最早那位还在的被挤掉，只剩 5 位", async () => {
    const { 切换收藏 } = await import("@/app/(app)/favorites");
    const { 读收藏 } = await import("@/lib/favorites");
    const ids = await 造(9);
    // 按 0..7 的顺序收藏：最早收的 0 排在最后
    for (const id of ids.slice(0, 8)) expect((await 切换收藏(id)).ok).toBe(true);
    // 删掉最近收的三位（5、6、7）。客户删除走的是业务删除，这里直接删库等价
    await prisma.customer.deleteMany({ where: { id: { in: ids.slice(5, 8) } } });
    expect((await 读收藏("tester-id")).length).toBe(5);

    await 切换收藏(ids[8]);
    const 现在 = (await 读收藏("tester-id")).map((x) => x.id);
    // 最早收藏的 0 号还在库里，人也没取消过它
    expect(现在).toContain(ids[0]);
    expect(现在.length).toBe(6);
  });
});
