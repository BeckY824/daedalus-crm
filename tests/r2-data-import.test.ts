/**
 * 二轮排查（r2-data）· 导入边界。
 *
 * 规矩（不变）：认人锁手机号、不覆盖只补空、逐格留空、没对上的列并进备注、整批可撤销。
 * 这里专挑「一份真实世界的表」会有的怪样子：空的、只有表头的、表头在第二行的、合并单元格、
 * 公式、上万行、各种编码、号码和日期的各种写法、撤销前后又动过的。
 * 走的是和界面一样的管线：文件字节 → 读xlsx / 解码CSV+解析CSV → 成表 → 猜列 → 预览 / 执行 / 撤销。
 * xlsx 夹具由 tests/fixtures/r2-data-make.py 用 openpyxl 生成。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 本地 } from "./r2-data-helpers";
import { 预览导入, 执行导入, 撤销批次, type 导入方案 } from "@/app/(app)/customers/import-actions";
import { patchCustomer } from "@/app/(app)/customers/actions";
import { saveFollowUp } from "@/app/(app)/customers/[id]/actions";
import { 解析CSV, 解码CSV, 成表, 行数上限 } from "@/lib/import/parse";
import { 读xlsx } from "@/lib/import/xlsx";
import { 字段表, 猜列, 像表头 } from "@/lib/import/fields";
import { 认日期 } from "@/lib/import/plan";
import { 规整手机号, 查电话 } from "@/lib/phone";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => { await prisma.$disconnect(); });

const 夹具 = (名: string) => new Uint8Array(readFileSync(path.join(__dirname, "fixtures", 名)));
const 表 = 字段表(DEFAULT_BUSINESS);

/** 和 ImportDrawer.收文件 一样的管线 */
function 收文件(名: string) {
  const bytes = 夹具(名);
  const rows = /\.xlsx$/i.test(名) ? 读xlsx(bytes) : 解析CSV(解码CSV(bytes));
  return 成表(rows);
}
function 方案(t: { 表头: string[]; 数据: string[][] }, 重复行: 导入方案["重复行"] = "跳过"): 导入方案 {
  return { 表头: t.表头, 数据: t.数据, 映射: 猜列(t.表头, 表), 重复行 };
}
const csv方案 = (csv: string, 重复行: 导入方案["重复行"] = "跳过") => 方案(成表(解析CSV(csv)), 重复行);

/* ------------------------------------------------------------------ */

describe("空的 / 只有表头 / 表头不在第一行", () => {
  it("空文件、只有空白行：读出来是空表（界面据此说「这份表里没有数据」）", () => {
    expect(成表(解析CSV(""))).toEqual({ 表头: [], 数据: [] });
    expect(成表(解析CSV("\n\n  \n"))).toEqual({ 表头: [], 数据: [] });
  });

  it("只有表头（csv / xlsx）：数据 0 行", () => {
    expect(成表(解析CSV("姓名,手机号\n")).数据).toEqual([]);
    expect(收文件("r2-data-只有表头.xlsx").数据).toEqual([]);
  });

  it("只有表头时直接调预览 / 执行：0 条、不报错", async () => {
    const r = await 执行导入(csv方案("姓名,手机号"), "空.csv");
    expect(r).toMatchObject({ ok: true, 新建: 0 });
  });

  it("【已知 2-6】表头在第二行（第一行是合并的大标题）：不能只剩一列", () => {
    const t = 收文件("r2-data-表头第二行.xlsx");
    // 第一行只有 A1 一格，成表按它定列数 = 1，后面三列全被截掉，手机号一个都进不来
    expect(t.数据.some((r) => r.includes("13800000001")), `只读到了 ${t.表头.length} 列：${JSON.stringify(t.数据[0])}`).toBe(true);
  });

  it("表头在第二行 + 制表符分隔：第一行没有制表符，分隔符被认成逗号，整张表塌成一列", () => {
    const t = 成表(解析CSV("客户名单\n姓名\t手机号\t公司\n张三\t13800000001\t远山资本"));
    expect(t.数据.some((r) => r.length >= 3 && r.includes("13800000001"))).toBe(true);
  });
});

describe("xlsx 的怪样子", () => {
  it("合并单元格：公司那一格竖着合并了三行，下面两位不该丢公司", () => {
    const t = 收文件("r2-data-合并单元格.xlsx");
    const 公司 = t.数据.map((r) => r[2]);
    expect(公司, "合并区只有左上那格有值，其余两人导进来公司是空的、没有任何提示").toEqual(["远山资本", "远山资本", "远山资本"]);
  });

  it("公式：Excel 存过的（有缓存值）读得出号码", () => {
    const t = 收文件("r2-data-公式.xlsx");
    expect(t.数据[0]).toEqual(["张三", "13800000001"]);
  });

  it("公式：没有缓存值（程序生成、没在 Excel 里打开过）读出来是空，挡下原因只说「没有手机号」（C，记录现状）", async () => {
    const t = 收文件("r2-data-公式.xlsx");
    expect(t.数据[1]).toEqual(["李四", ""]);
    const r = await 预览导入(方案(t));
    if (!r.ok) throw new Error(r.error);
    expect(r.预览.挡下).toEqual([{ 行号: 3, 原因: "这一行没有手机号" }]);
  });

  it.skip("【下一版】【C】1904 日期系统的簿子：预计签约不该差出四年", async () => {
    const t = 收文件("r2-data-1904.xlsx");
    const w = await 执行导入(方案(t), "mac.xlsx");
    if (!w.ok) throw new Error(w.error);
    const c = await prisma.customer.findFirstOrThrow();
    expect(c.expectedSignAt?.getFullYear(), `存成了 ${c.expectedSignAt?.toLocaleDateString()}`).toBe(2026);
  });

  it("【已知 2-7】没对上的日期列并进备注时写的是 Excel 序列号，不是日期", async () => {
    const t = 收文件("r2-data-日期并进备注.xlsx");
    const w = await 执行导入(方案(t), "a.xlsx");
    if (!w.ok) throw new Error(w.error);
    const c = await prisma.customer.findFirstOrThrow();
    expect(c.remark).toBe("加微信日期：2026-09-19");
  });

  it("中间夹一行自闭合的空行（<row …/>）：前后几位都在、没错位", () => {
    const t = 收文件("r2-data-空行自闭合.xlsx");
    expect(t.数据).toEqual([["张三", "13800000001"], ["李四", "13800000002"], ["王五", "13800000003"]]);
  });

  it.skip("【下一版】超宽（60 列）：截到 50 列，并且如实说原表有几列", () => {
    const t = 收文件("r2-data-超宽.xlsx");
    expect(t.表头).toHaveLength(50);
    expect(t.截断了?.列, "界面写「原表 N 列」，N 应是 60").toBe(60);
  });

  it.skip("【下一版】上万行（10050 行）：只读前 10000 行，并且如实说原表有几行", () => {
    const t0 = Date.now();
    const t = 收文件("r2-data-上万行.xlsx");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(t.数据).toHaveLength(行数上限);
    expect(t.截断了?.行, "界面写「原表 N 行」，N 应是 10050").toBe(10050);
  });
});

describe("文本编码与分隔符", () => {
  it("UTF-8 带 BOM、GBK：表头和中文都对", () => {
    for (const 名 of ["r2-data-utf8bom.csv", "r2-data-gbk.csv"]) {
      const t = 收文件(名);
      expect(t.表头, 名).toEqual(["姓名", "手机号", "公司"]);
      expect(t.数据[0], 名).toEqual(["张三", "13800000001", "远山资本"]);
    }
  });

  it("Excel「Unicode 文本」（UTF-16LE + BOM、制表符）：选文件框收 .txt，读出来不能是乱码", () => {
    const t = 收文件("r2-data-utf16.txt");
    expect(t.表头).toEqual(["姓名", "手机号", "公司"]);
  });

  it("制表符、分号分隔都认得", () => {
    expect(成表(解析CSV("姓名\t手机号\n张三\t13800000001")).数据[0]).toEqual(["张三", "13800000001"]);
    expect(成表(解析CSV("姓名;手机号\n张三;13800000001")).数据[0]).toEqual(["张三", "13800000001"]);
  });

  it("字段里有逗号、换行、成对引号（RFC 4180）：原样", () => {
    const t = 成表(解析CSV('姓名,手机号,备注\n张三,13800000001,"他说""再看看"",\n下周回电"'));
    expect(t.数据[0][2]).toBe('他说"再看看",\n下周回电');
  });

  it("【A】没加引号的字段中间有一个英文双引号：后面的人不能被吞进这一格", async () => {
    // 非 Excel 导出的 csv（别的系统、手写）里很常见：5" 屏、王总"老客户"
    const csv = '姓名,手机号,备注\n张三,13800000001,要 5" 的屏\n李四,13800000002,好\n王五,13800000003,好';
    const t = 成表(解析CSV(csv));
    expect(t.数据.map((r) => r[0]), `读成了 ${JSON.stringify(t.数据)}`).toEqual(["张三", "李四", "王五"]);
  });
});

describe("号码列的各种写法", () => {
  it("带字、带国家码、全角数字、带空格横杠、Excel 的 .0 尾巴：都认成同一个号", () => {
    for (const v of ["13800001111", "138 0000 1111", "138-0000-1111", "+86 138 0000 1111", "0086-13800001111", "１３８００００１１１１", "13800001111.0", "'13800001111", "13800001111（微信同号）", "手机:13800001111"]) {
      expect(规整手机号(v), v).toBe("13800001111");
    }
  });

  it("【A】全角横杠 / 破折号分隔的号码（中文输入法、Word 自动替换）：要认成同一个号，不能原样进库", () => {
    for (const v of ["138－0000－1111", "138—0000—1111", "138–0000–1111", "138‐0000‐1111"]) {
      expect(规整手机号(v), v).toBe("13800001111");
    }
  });

  it("全角横杠的号码导进去，再用干净的号码导一次：应认出是同一个人（现状建出两位）", async () => {
    await 执行导入(csv方案("姓名,手机号\n王强,138－0000－1111"), "a.csv");
    await 执行导入(csv方案("姓名,手机号\n王强,13800001111"), "b.csv");
    expect(await prisma.customer.count()).toBe(1);
  });

  it("两个号码：用 / 或、隔开的取第一个、原文并进备注", async () => {
    const w = await 执行导入(csv方案("姓名,手机号\n王强,13800001111 / 13900002222\n李娜,13800003333、13900004444"), "a.csv");
    if (!w.ok) throw new Error(w.error);
    const 人 = await prisma.customer.findMany({ orderBy: { phone: "asc" } });
    expect(人.map((c) => c.phone)).toEqual(["13800001111", "13800003333"]);
    expect(人[0].remark).toContain("13900002222");
  });

  it("【B】两个号码只用空格隔开：整行被挡、原因写「不像一个电话号码」（应取第一个或说清是两个号）", async () => {
    const r = await 预览导入(csv方案("姓名,手机号\n王强,13800001111 13900002222"));
    if (!r.ok) throw new Error(r.error);
    expect(r.预览.新建, `挡下原因：${JSON.stringify(r.预览.挡下)}`).toBe(1);
  });

  it("海外、座机、分机：照收；打码号码：挡", () => {
    expect(查电话("+1 (415) 555-0123", { 必填: true })).toEqual({ ok: true, phone: "+14155550123" });
    expect(查电话("+852 9123 4567", { 必填: true })).toEqual({ ok: true, phone: "+85291234567" });
    // 分机号留着（第二轮复查：原来悄悄扔掉）
    expect(查电话("010-12345678 转 8001", { 必填: true })).toEqual({ ok: true, phone: "01012345678转8001" });
    expect(查电话("138****1111", { 必填: true }).ok).toBe(false);
  });

  it("号码列里是姓名（列对错了）：整行挡下并说原因", async () => {
    const r = await 预览导入(csv方案("姓名,手机号\n王强,王强"));
    if (!r.ok) throw new Error(r.error);
    expect(r.预览.挡下[0].原因).toBe("手机号看不出是个号码");
  });
});

describe("日期列的各种写法", () => {
  it("文本日期、Excel 序列号都认成本地那一天的零点", () => {
    for (const v of ["2026-09-19", "2026/9/19", "2026年9月19日", "2026.9.19", "2026-09-19 14:30", "46284", "46284.75"]) {
      const d = 认日期(v);
      expect(d && [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()], v).toEqual([2026, 9, 19, 0]);
    }
  });

  it("不存在的日子（2026-02-29、2026-02-30、13 月）认不出、不猜；闰年 2028-02-29 认得", () => {
    expect(认日期("2026-02-29")).toBeNull();
    expect(认日期("2026/2/30")).toBeNull();
    expect(认日期("2026-13-01")).toBeNull();
    expect(认日期("2028-02-29")?.getDate()).toBe(29);
  });

  it("月末、跨年：12 月 31 日、1 月 1 日原样", () => {
    expect(认日期("2026-12-31")?.getTime()).toBe(本地(2026, 12, 31).getTime());
    expect(认日期("2027/1/1")?.getTime()).toBe(本地(2027, 1, 1).getTime());
  });

  it("美式 9/19/2026、没年份的 9月19日：认不出，留空并标出（不猜）", async () => {
    expect(认日期("9/19/2026")).toBeNull();
    expect(认日期("9月19日")).toBeNull();
    const r = await 预览导入(csv方案("姓名,手机号,预计签约\n王强,13800001111,9/19/2026"));
    if (!r.ok) throw new Error(r.error);
    expect(r.预览.待复核[0]).toMatchObject({ 严重: "留空", 原值: "9/19/2026" });
  });

  it("【C】8 位连写的 20260919（不少系统这么导）认不出", () => {
    expect(认日期("20260919")?.getDate()).toBe(19);
  });
});

describe("重复与库里已有", () => {
  // 2026-10-04 J-051 修好，去掉 skip
  it("表里同号两行：后一行的「没对上的列」不该悄悄丢掉（B：原来第一行有备注就整段丢）", async () => {
    const w = await 执行导入(csv方案("姓名,手机号,微信号\n张三,13800000001,zs_wx\n张三,13800000001,zs_wx2"), "a.csv");
    if (!w.ok) throw new Error(w.error);
    const c = await prisma.customer.findFirstOrThrow();
    expect(c.remark ?? "").toContain("zs_wx2");
  });

  it("库里已有、备注有值，选「只补空」：库里的备注一字不动", async () => {
    await prisma.customer.create({ data: { name: "张三", phone: "13800000001", remark: "人手录的", salesOwnerId: 我 } });
    await 执行导入(csv方案("姓名,手机号,备注,公司\n张三,13800000001,表里的,远山", "补空"), "a.csv");
    const c = await prisma.customer.findFirstOrThrow();
    expect([c.remark, c.school]).toEqual(["人手录的", "远山"]);
  });

  it.skip("【下一版】【B】库里已有、该补的格子都有值：预览说「补空 1」，实际补空 0、跳过 1（预览数 ≠ 实际数）", async () => {
    await prisma.customer.create({ data: { name: "张三", phone: "13800000001", school: "远山", salesOwnerId: 我 } });
    const p = csv方案("姓名,手机号,公司\n张三,13800000001,平川", "补空");
    const r = await 预览导入(p);
    if (!r.ok) throw new Error(r.error);
    const w = await 执行导入(p, "a.csv");
    if (!w.ok) throw new Error(w.error);
    expect({ 补空: r.预览.补空, 跳过: r.预览.跳过 }).toEqual({ 补空: w.补空, 跳过: w.跳过 });
  });

  it.skip("【下一版】【B】库里已有、备注有值：表里没对上的列（微信号）整列没进来，预览也不说", async () => {
    await prisma.customer.create({ data: { name: "张三", phone: "13800000001", remark: "人手录的", salesOwnerId: 我 } });
    const p = csv方案("姓名,手机号,微信号\n张三,13800000001,zs_wx", "补空");
    const r = await 预览导入(p);
    if (!r.ok) throw new Error(r.error);
    await 执行导入(p, "a.csv");
    const c = await prisma.customer.findFirstOrThrow();
    // 不覆盖是对的；但「没对上的列并进备注」在这条路上一个字都没留下，预览里补空 0、跳过 1，人以为表里没新东西
    expect((c.remark ?? "").includes("zs_wx") || r.预览.待复核.length > 0, `备注=${c.remark}；预览=${JSON.stringify(r.预览)}`).toBe(true);
  });
});

describe("撤销", () => {
  it("撤销时其中几位已被改过 / 记过跟进：只删没动过的，动过的留着并说为什么", async () => {
    const w = await 执行导入(csv方案("姓名,手机号\n甲,13800000001\n乙,13800000002\n丙,13800000003"), "a.csv");
    if (!w.ok) throw new Error(w.error);
    const [甲, 乙] = await prisma.customer.findMany({ orderBy: { phone: "asc" } });
    await new Promise((r) => setTimeout(r, 5));
    await patchCustomer(甲.id, "remark", "导完马上改了");
    await saveFollowUp({ customerId: 乙.id, type: "PHONE", content: "打过了", status: "已完成", occurredAt: new Date().toISOString() });
    const r = await 撤销批次(w.batchId);
    if (!r.ok) throw new Error(r.error);
    expect(r.删掉).toBe(1);
    expect(r.没动.map((x) => x.name).sort()).toEqual(["乙", "甲"]);
    expect((await prisma.customer.findMany()).map((c) => c.name).sort()).toEqual(["乙", "甲"]);
  });

  it("整批撤销后再导同一份：重新建出来、批次各管各的", async () => {
    const p = csv方案("姓名,手机号\n甲,13800000001\n乙,13800000002");
    const w1 = await 执行导入(p, "a.csv");
    if (!w1.ok) throw new Error(w1.error);
    await 撤销批次(w1.batchId);
    const w2 = await 执行导入(p, "a.csv");
    expect(w2).toMatchObject({ ok: true, 新建: 2 });
    expect(await 撤销批次(w1.batchId)).toMatchObject({ ok: false });
    expect(await prisma.customer.count()).toBe(2);
  });

  it.skip("【下一版】【B】先导 A（新建）、再导 B（补空同一批人），倒着撤 B 再撤 A：A 建的人应能撤掉", async () => {
    const wA = await 执行导入(csv方案("姓名,手机号\n甲,13800000001"), "A.csv");
    if (!wA.ok) throw new Error(wA.error);
    await new Promise((r) => setTimeout(r, 5));
    const wB = await 执行导入(csv方案("姓名,手机号,公司\n甲,13800000001,远山", "补空"), "B.csv");
    if (!wB.ok) throw new Error(wB.error);
    expect(wB.补空).toBe(1);
    const rB = await 撤销批次(wB.batchId);
    expect(rB).toMatchObject({ ok: true, 还原: 1 });
    const rA = await 撤销批次(wA.batchId);
    // 撤 B 时把公司还原成空，这一写改了 updatedAt；撤 A 时就当「导入之后又改过他的档案」留着了
    expect(await prisma.customer.count(), `撤 A 的结果：${JSON.stringify(rA)}`).toBe(0);
  });
});

describe("上万行", () => {
  it("一次导 10000 行：全进、预览数 = 实际数、撤销也撤得完", async () => {
    const 行 = Array.from({ length: 10000 }, (_, i) => `客户${i},136${String(i).padStart(8, "0")}`);
    const p = csv方案("姓名,手机号\n" + 行.join("\n"));
    const t0 = Date.now();
    const r = await 预览导入(p);
    if (!r.ok) throw new Error(r.error);
    expect(r.预览.新建).toBe(10000);
    const w = await 执行导入(p, "big.csv");
    const 用时 = Date.now() - t0;
    if (!w.ok) throw new Error(w.error);
    expect(w.新建).toBe(10000);
    console.log(`[r2-data] 10000 行预览+落库用时 ${用时} ms`);
    const t1 = Date.now();
    const u = await 撤销批次(w.batchId);
    console.log(`[r2-data] 10000 行撤销用时 ${Date.now() - t1} ms`);
    expect(u).toMatchObject({ ok: true, 删掉: 10000 });
  }, 300_000);

  it("像表头：第一行就是号码时识别为「没有表头」", () => {
    expect(像表头(["王强", "13800001111"])).toBe(false);
    expect(像表头(["姓名", "手机号"])).toBe(true);
  });
});
