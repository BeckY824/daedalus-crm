/**
 * 第四轮对抗复查 · 号码（5bd3e32：ext / x 统一成「转」、查重认「主号」）
 *
 * 红的保持红，等修。
 *   一、「主号」分不清老库和新库：0.46.15 里新录的总机「010-12345678」（不带分机），会让同一总机下所有带分机的人都建不了
 *   二、导入：表里先出现主号、后出现带分机的号——预览说新建 2，执行只建 1（后一位被当成前一位的重复）；顺序反过来又是 2
 *   三、导入：老库一位存主号、表里两位分机不同的人——两位都「补空」进同一位老客户
 *   四、大陆手机号后面带英文分机（「13800001111 ext 8」）：分机被丢了，也不进备注（中文「转 8」会进备注）
 *   五、分机后面再带一点字（「x12 (office)」）：整格被拒
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { checkDuplicate } from "@/app/(app)/customers/actions";
import { 预览导入, 执行导入, type 导入方案 } from "@/app/(app)/customers/import-actions";
import { 解析CSV, 成表 } from "@/lib/import/parse";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { 规整手机号, 号码带着字, 像手机号 } from "@/lib/phone";

beforeEach(async () => {
  await resetDb();
  await prisma.user.create({ data: { id: "tester-id", email: "t@x", name: "测试员", title: "管理员", role: "ADMIN", password: "x" } });
});
afterAll(async () => { await prisma.$disconnect(); });

function 方案(csv: string, 重复行: 导入方案["重复行"] = "跳过"): 导入方案 {
  const { 表头, 数据 } = 成表(解析CSV(csv));
  return { 表头, 数据, 映射: 猜列(表头, 字段表(DEFAULT_BUSINESS)), 重复行 };
}
const 建客户 = (name: string, phone: string, extra: Record<string, unknown> = {}) =>
  prisma.customer.create({ data: { name, phone, salesOwnerId: "tester-id", ...extra } });

describe("主号认人：分不清「老库丢了分机」和「新库里本来就是总机」", () => {
  it("0.46.15 里录了公司总机（前台）「010-12345678」，再录同一总机分机 802 的王经理：被说成重复", async () => {
    await 建客户("某某公司前台", "01012345678");
    // 新版本里人手录的总机和老版本丢了分机存下的主号，库里长得一模一样——同号写法把它们一律当「同一个人」
    expect(await checkDuplicate("010-12345678 转 802")).toBeNull();
  });
});

describe("导入：主号和带分机的号在同一份表里", () => {
  const 表 = "姓名,手机号\n前台,010-12345678\n王经理,010-12345678 转 801";

  it("空库：预览说新建 2，执行也得是 2（现在执行时王经理被认成前台的重复）", async () => {
    const p = await 预览导入(方案(表));
    if (!p.ok) throw new Error(p.error);
    expect(p.预览.新建).toBe(2);
    const w = await 执行导入(方案(表), "a.csv");
    if (!w.ok) throw new Error(w.error);
    // 执行时建完「前台」就 库里.set(主号)；下一行 库里.get(带分机) 没有 → 库里.get(主号(…)) 命中前台 → 跳过
    expect(w.新建, `新建 ${w.新建}、跳过 ${w.跳过}`).toBe(2);
    expect(await prisma.customer.count({ where: { name: "王经理" } })).toBe(1);
  });
});

describe("导入：老库存了主号、表里同一总机两位分机不同的人", () => {
  it("补空模式：两位都补进同一位老客户（一位的备注、另一位的专业混在一张档案上）", async () => {
    const 老 = await 建客户("老客户", "01012345678");
    const csv = "姓名,手机号,备注,专业\n王经理,010-12345678 转 801,王经理的备注,\n李经理,010-12345678 转 802,,李经理的专业";
    const w = await 执行导入(方案(csv, "补空"), "b.csv");
    if (!w.ok) throw new Error(w.error);
    const 后 = await prisma.customer.findUniqueOrThrow({ where: { id: 老.id } });
    // 两行是两个号码（分机不同），却都落到了同一条老档案上。至多一行能认它，另一行该算「说不清」
    expect(w.补空, `备注=${后.remark} 专业=${后.major}`).toBeLessThanOrEqual(1);
  });
});

describe("英文分机的几种写法", () => {
  it("大陆手机号后面写「ext 8」：分机被去掉了，号码带着字 也说没丢东西——不进备注", () => {
    expect(规整手机号("13800001111 ext 8")).toBe("13800001111");
    // 中文写法「13800001111转8」是进备注的（号码带着字 = true）；英文写法丢得无声无息
    expect(号码带着字("13800001111 ext 8")).toBe(true);
  });
  it("分机后面再带一点字「+1 415 555 0132 x12 (office)」：整格被拒（ext 正则锚在行尾）", () => {
    const 规 = 规整手机号("+1 415 555 0132 x12 (office)");
    expect(像手机号(规), `规整成 ${规}`).toBe(true);
  });
});
