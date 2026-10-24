/**
 * 两人同时领同一个公海项目（D-35 / 一周模拟 D7）：先进来的领走了，项目落到后进来那位的范围外，
 * 带限定查是空的。没领到的人要看到「被人领走了」，不是「不在了，刷新看看」；真删了的照旧说不在了。
 * 限定层换成假的：被藏起来的项目只有 看全部() 里看得到（和 lib/team-scope.ts 线上行为一致）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const 藏 = vi.hoisted(() => ({ ids: new Set<string>(), 看全部中: false }));
vi.mock("@/lib/team-scope", async (原) => ({
  ...(await 原<object>()),
  看全部: async <T,>(fn: () => Promise<T>) => {
    藏.看全部中 = true;
    try { return await fn(); } finally { 藏.看全部中 = false; }
  },
}));
vi.mock("@/lib/prisma", async (原) => {
  const 真 = await 原<typeof import("@/lib/prisma")>();
  const prisma = 真.prisma.$extends({
    query: {
      project: {
        async findUnique({ args, query }) {
          const id = (args.where as { id?: string }).id;
          if (id && 藏.ids.has(id) && !藏.看全部中) return null;
          return query(args);
        },
      },
    },
  });
  return { ...真, prisma };
});

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 领取公海项目 } from "@/lib/project/db";
import { invalidateSettingsCache } from "@/lib/settings";

let 乙: { id: string; role: string };
let 丙: { id: string; role: string };
let 客户: string;

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  藏.ids.clear();
  const 人 = async (email: string) => ({ id: (await prisma.user.create({ data: { email, name: email, title: "", role: "SALES", password: "x" } })).id, role: "SALES" });
  乙 = await 人("yi");
  丙 = await 人("bing");
  客户 = (await prisma.customer.create({ data: { name: "客户甲", phone: "13800000001", salesOwnerId: 乙.id } })).id;
});

describe("两人同时领同一个公海项目", () => {
  it("先领到的拿走；后进来的看不到这个项目了，说「被人领走了」，不说「不在了」", async () => {
    const p = await prisma.project.create({ data: { name: "一号项目", customerId: 客户, ownerId: 乙.id, creatorId: 乙.id, pooledAt: new Date() } });
    expect(await 领取公海项目(丙, p.id)).toEqual({ ok: true });
    藏.ids.add(p.id); // 现在是丙的，乙带限定看不到
    const r = await 领取公海项目(乙, p.id);
    expect(r).toEqual({ ok: false, error: "这个项目已经被人领走了" });
    藏.ids.clear();
    expect(await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ ownerId: 丙.id, pooledAt: null });
  });

  it("真删了的照旧说不在了", async () => {
    expect(await 领取公海项目(丙, "没有这个项目")).toEqual({ ok: false, error: "这个项目已经不在了，刷新看看" });
  });
});
