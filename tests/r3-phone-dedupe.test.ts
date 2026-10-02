/**
 * 第三轮 B4：分机现在留在号码里（「01012345678转801」），老库里同一个人存的是主号「01012345678」。
 * 查重时主号也认（lib/phone 的 同号写法）：表单查重、保存、导入预览三条路都认得出是同一个人。
 * 两个分机不同的人（同一个总机）不算同一个人。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "u-dd", name: "甲", email: "a@x", role: "ADMIN", title: "" }) }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { checkDuplicate } from "@/app/(app)/customers/actions";

beforeEach(async () => {
  await resetDb();
  await prisma.user.create({ data: { id: "u-dd", email: "a@x", name: "甲", role: "ADMIN", password: "x" } });
  await prisma.customer.create({ data: { name: "老张", phone: "01012345678", salesOwnerId: "u-dd" } });
  await prisma.customer.create({ data: { name: "小李", phone: "07551234567转802", salesOwnerId: "u-dd" } });
});
afterAll(async () => { await prisma.$disconnect(); });

describe("带分机的号码查重认老写法", () => {
  it("老库里存主号，新写法带分机：认得出", async () => {
    expect((await checkDuplicate("010-12345678 转 801"))?.name).toBe("老张");
    expect((await checkDuplicate("010-12345678 ext. 801"))?.name).toBe("老张");
  });
  it("同一个总机、分机不同：不算同一个人", async () => {
    expect(await checkDuplicate("0755-1234567 转 803")).toBeNull();
    expect((await checkDuplicate("0755-1234567 转 802"))?.name).toBe("小李");
  });
});
