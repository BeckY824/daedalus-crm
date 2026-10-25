/**
 * 两人真同时领同一个公海项目（质量审 #136 时提的）：两次领取一起发出去，只能一个人领到，
 * 项目落在领到的人名下，转让记录只有一行；没领到的那位拿到的是失败，不是报错。
 * project-claim-race 用假限定层排了先后，这里不排，靠事务本身挡住第二个人。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 领取公海项目 } from "@/lib/project/db";
import { invalidateSettingsCache } from "@/lib/settings";

let 乙: { id: string; role: string };
let 丙: { id: string; role: string };
let 丁: { id: string; role: string };

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  const 人 = async (email: string) => ({ id: (await prisma.user.create({ data: { email, name: email, title: "", role: "SALES", password: "x" } })).id, role: "SALES" });
  乙 = await 人("yi");
  丙 = await 人("bing");
  丁 = await 人("ding");
});

describe("两人真同时领同一个公海项目", () => {
  it("只有一个人领到，项目在他名下，转让只记一行", async () => {
    const 客户 = (await prisma.customer.create({ data: { name: "客户甲", phone: "13800000001", salesOwnerId: 乙.id } })).id;
    const p = await prisma.project.create({ data: { name: "一号项目", customerId: 客户, ownerId: 乙.id, creatorId: 乙.id, pooledAt: new Date() } });

    const [丙的, 丁的] = await Promise.all([领取公海项目(丙, p.id), 领取公海项目(丁, p.id)]);

    const 领到 = [丙的, 丁的].filter((r) => r.ok);
    expect(领到).toHaveLength(1);
    const 赢家 = 丙的.ok ? 丙 : 丁;
    const 输的 = 丙的.ok ? 丁的 : 丙的;
    expect(输的).toMatchObject({ ok: false });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ ownerId: 赢家.id, pooledAt: null });
    const 领取记录 = await prisma.projectNodeLog.findMany({ where: { projectId: p.id, kind: "pool-claim" } });
    expect(领取记录).toHaveLength(1);
  });
});
