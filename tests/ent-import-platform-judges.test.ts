/**
 * 企业版导入 · 裁判（两种平台导出格式）：tests/fixtures/ent-sample-feishu/、ent-sample-dingtalk/
 * （scripts/make-ent-import-sample-platforms.py 生成）各走一遍客户拿到材料后的整套流程：
 *   上传 → 试跑 → 下载对照表 → 填空着的值、重名负责人填邮箱 → 传回 → 重新试跑 → 导入 → 同一批再导一次 → 撤回。
 * 对账：试跑报告（先演一遍）的数 = 写入结果 = 库里各表真实多出来的行；跳过的正好是 说明.md 里放的脏数据。
 * 幂等：同一批再传一次（带上次认过的映射，和上传接口一样），零新建零更新，库里一格不变。
 * 来回：两批倒着撤回，除日志表外每张表和导入前逐行一样。
 *
 * 对照表里填什么是测试这边的事（模拟客户填表），src 里不写死任何一家的阶段名、负责人。
 */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 试跑, 重新试跑, type 试跑报告 } from "@/lib/enterprise-import/report";
import { 写一批 } from "@/lib/enterprise-import/apply";
import { 撤回一批 } from "@/lib/enterprise-import/revert";
import { 已认映射 } from "@/lib/enterprise-import/sync";
import { 读文件们, type 读出的表 } from "@/lib/enterprise-import/excel";
import { 导出对照表, 读回对照表, 对照表头 } from "@/lib/enterprise-import/template";
import { 解析CSV带行号, 解码CSV } from "@/lib/import/parse";
import { 实体顺序, type 实体 } from "@/lib/enterprise-import/types";

const 我 = { id: "tester-id", name: "测试员" };
const 模型: Record<实体, string> = { customer: "Customer", contact: "Contact", lead: "Lead", opportunity: "Opportunity", followup: "FollowUp" };

type 样例 = {
  目录: string;
  文件们: string[];
  /** 读出来的表：[表名, 实体, 行数] */
  表: [string, 实体, number][];
  /** 说明.md 里放的、该跳过的脏数据（实体 → 类别 → 条数） */
  该跳过: Partial<Record<实体, Record<string, number>>>;
  /** 客户填对照表：重名负责人填哪个邮箱 */
  负责人填: Record<string, string>;
};

const 样例们: 样例[] = [
  {
    目录: "ent-sample-feishu",
    文件们: ["客户管理.xlsx"],
    表: [
      ["客户管理.xlsx·客户", "customer", 39],
      ["客户管理.xlsx·联系人", "contact", 49],
      ["客户管理.xlsx·商机", "opportunity", 25],
      ["客户管理.xlsx·跟进记录", "followup", 61],
    ],
    该跳过: {
      customer: { 缺必填: 1 },
      contact: { 找不到客户: 1, 客户不唯一: 2 },
      opportunity: { 找不到客户: 1 },
      followup: { 客户不唯一: 1 },
    },
    负责人填: { 王芳: "wangfang.hz@sample.invalid", 李强: "liqiang.hz@sample.invalid" },
  },
  {
    目录: "ent-sample-dingtalk",
    文件们: ["客户.xlsx", "商机.xlsx", "跟进记录.xlsx"],
    表: [
      ["客户.xlsx", "customer", 37],
      ["客户.xlsx（联系人）", "contact", 51],
      ["商机.xlsx", "opportunity", 23],
      ["跟进记录.xlsx", "followup", 51],
    ],
    该跳过: {
      customer: { 缺必填: 1 },
      opportunity: { 客户不唯一: 1 },
      followup: { 找不到客户: 1 },
    },
    负责人填: { 李强: "liqiang.sh@sample.invalid" },
  },
];

/* 日志 / 回收区本来就会多出来，不算在「来回」里；其余每张表都比 */
const 不比 = new Set(["AuditLog", "EntImportBatch", "EntImportRow", "EntTrash", "EntSnapshot"]);
type 快照 = Record<string, string[]>;
async function 拍(): Promise<快照> {
  const 照: 快照 = {};
  for (const m of Prisma.dmmf.datamodel.models) {
    if (不比.has(m.name)) continue;
    const d = (prisma as unknown as Record<string, { findMany: () => Promise<unknown[]> }>)[m.name[0].toLowerCase() + m.name.slice(1)];
    照[m.name] = (await d.findMany()).map((r) => JSON.stringify(r)).sort();
  }
  return 照;
}
const 行数 = (照: 快照) => Object.fromEntries(Object.entries(照).map(([k, v]) => [k, v.length]));
const 合计 = (报告: 试跑报告) => (k: "新建" | "更新" | "没变" | "并入" | "待写") => 实体顺序.reduce((a, e) => a + 报告.按类[e][k], 0);
const 数问题 = (报告: 试跑报告, 级别: "跳过" | "提醒", e?: 实体) => {
  const 数: Record<string, number> = {};
  for (const q of 报告.问题) if (q.级别 === 级别 && (!e || q.实体 === e)) 数[q.类别] = (数[q.类别] ?? 0) + 1;
  return 数;
};

const 格 = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** 模拟客户填对照表：空着的值填「能填的」里第一个，重名的负责人填邮箱；其余照导出的不动 */
function 填表(csv: string, 负责人填: Record<string, string>): { bytes: Uint8Array; 填了: number } {
  const { rows } = 解析CSV带行号(解码CSV(new TextEncoder().encode(csv)));
  const [类别, 原, 我们, 能填] = (["类别", "原系统写法", "我们这边", "能填的"] as const).map((h) => rows[0].indexOf(h));
  let 填了 = 0;
  for (const r of rows.slice(1)) {
    if (r[类别] === "负责人" && 负责人填[r[原]]) {
      r[我们] = 负责人填[r[原]];
      填了++;
    } else if (!["列", "负责人", "默认负责人"].includes(r[类别]) && !r[我们]) {
      r[我们] = r[能填].split("、")[0];
      填了++;
    }
  }
  return { bytes: new TextEncoder().encode("﻿" + rows.map((r) => r.map(格).join(",")).join("\r\n")), 填了 };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(样例们)("裁判 · $目录", (样) => {
  const 目录 = join(__dirname, "fixtures", 样.目录);
  let 表们: 读出的表[] = [];
  let 成员们: { id: string; name: string; email: string }[] = [];
  let 导入前: 快照 = {};
  let 导入后: 快照 = {};
  let 首报告: 试跑报告;
  let 报告1: 试跑报告;
  let 批1 = "";
  let 批2 = "";
  let 表格: Uint8Array;

  it("准备：按员工名单建在职账号；读文件认对了每张表的实体，隐藏表 / 空表不读", async () => {
    await resetDb();
    invalidateSettingsCache();
    await prisma.user.create({ data: { id: 我.id, email: "t@x", name: 我.name, title: "管理员", role: "ADMIN", password: "x" } });
    const 员 = 读文件们({ 名: "员工与部门.xlsx", bytes: new Uint8Array(readFileSync(join(__dirname, "fixtures/ent-sample/员工与部门.xlsx"))) })[0];
    const ix = (h: string) => 员.表头.indexOf(h);
    for (const r of 员.行) {
      if (r[ix("在职状态")] === "在职") await prisma.user.create({ data: { email: String(r[ix("邮箱")]), name: String(r[ix("姓名")]), title: String(r[ix("职位")]), role: "SALES", password: "x" } });
    }
    expect(await prisma.user.count({ where: { role: "SALES" } })).toBe(26);
    成员们 = (await prisma.user.findMany({ select: { id: true, name: true, email: true } })).map((u) => ({ ...u, email: u.email ?? "" }));

    表们 = 样.文件们.flatMap((n) => 读文件们({ 名: n, bytes: new Uint8Array(readFileSync(join(目录, n))) }));
    expect(表们.map((t) => [t.名, t.实体, t.行.length])).toEqual(样.表);
    导入前 = await 拍();
  });

  it("对照表来回：导出 → 填空着的值、重名负责人填邮箱 → 读回零问题 → 重新试跑后值都认上了、重名负责人认到本人", async () => {
    const 试 = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: 表们, 建议器: null });
    批1 = 试.批次Id;
    首报告 = 试.报告;
    // 规则认不出的值（平台自己的阶段名、跟进方式、状态）就空着等人填
    expect(首报告.映射.值.filter((v) => !v.我们的值).length, "样例里要有规则认不出的值").toBeGreaterThan(0);
    expect(数问题(首报告, "提醒").负责人对不上 ?? 0).toBeGreaterThan(0);

    const csv = 导出对照表(首报告, 成员们);
    expect(解析CSV带行号(解码CSV(new TextEncoder().encode(csv))).rows[0]).toEqual([...对照表头]);
    const 填 = 填表(csv, 样.负责人填);
    表格 = 填.bytes;
    const 回 = 读回对照表({ 名: "对照表.csv", bytes: 表格 }, 首报告, 成员们);
    expect(回.问题).toEqual([]);
    expect(回.改了).toBe(填.填了);

    报告1 = (await 重新试跑(批1, 回.改, 我.id)).报告;
    expect(报告1.映射.值.filter((v) => !v.我们的值)).toEqual([]);
    expect(数问题(报告1, "提醒").阶段对不上 ?? 0).toBe(0);
    for (const [写法, 邮箱] of Object.entries(样.负责人填)) {
      expect(报告1.映射.负责人.find((p) => p.写法 === 写法)?.成员Id, 写法).toBe(成员们.find((u) => u.email === 邮箱)!.id);
    }
    // 填好负责人后，「负责人对不上」少了正好那几个重名的
    const 前 = 首报告.问题.filter((q) => q.类别 === "负责人对不上").length;
    const 后 = 报告1.问题.filter((q) => q.类别 === "负责人对不上").length;
    expect(后).toBeLessThan(前);
    // 跳过的数据和对照表无关：照旧是说明里那几条
    expect(数问题(报告1, "跳过")).toEqual(数问题(首报告, "跳过"));
  });

  it("对账：跳过的正好是说明里的脏数据；报告（先演一遍）= 写入结果 = 库里各表增减", async () => {
    for (const e of 实体顺序) {
      const 实际 = 数问题(报告1, "跳过", e);
      expect(实际, e).toEqual(样.该跳过[e] ?? {});
      expect(报告1.按类[e].跳过, e).toBe(Object.values(实际).reduce((a, b) => a + b, 0));
    }
    expect(报告1.合计.记录).toBe(报告1.合计.待写 + 报告1.合计.跳过);
    expect(报告1.合计.记录).toBe(样.表.reduce((a, t) => a + t[2], 0));
    expect(await 拍(), "试跑不该动库").toEqual(导入前);

    const 写 = await 写一批(批1, 我);
    导入后 = await 拍();
    const 合 = 合计(报告1);
    expect(写).toMatchObject({ 状态: "done", 完了: true, 失败: 0, 冲突: 0 });
    expect(写.总数).toBe(合("待写"));
    expect(写.写到).toBe(写.总数);
    expect(报告1.预演?.合计).toEqual({ 新建: 写.新建, 更新: 写.更新, 跳过: 写.跳过, 冲突: 写.冲突, 失败: 写.失败 });
    expect(写.新建).toBe(合("新建"));
    expect(写.跳过).toBe(报告1.合计.跳过 + 合("并入") + 合("没变"));

    const 前 = 行数(导入前);
    const 后 = 行数(导入后);
    for (const e of 实体顺序) expect(后[模型[e]] - 前[模型[e]], e).toBe(报告1.按类[e].新建);
    expect(后.EntExternalRef - 前.EntExternalRef).toBe(报告1.合计.待写);
    expect(后.User).toBe(前.User);

    // 对照表里填的落进库了：重名负责人填了邮箱的客户都在本人名下；规则认不出的阶段换成了填的值
    for (const [写法, 邮箱] of Object.entries(样.负责人填)) {
      const id = 成员们.find((u) => u.email === 邮箱)!.id;
      expect(await prisma.customer.count({ where: { salesOwnerId: id } }), 写法).toBeGreaterThan(0);
    }
    const 合法阶段 = new Set(报告1.映射.值.filter((v) => v.名 === "阶段").map((v) => v.我们的值));
    for (const o of await prisma.opportunity.findMany({ select: { stage: true } })) expect(合法阶段.has(o.stage), o.stage).toBe(true);
  });

  it("幂等：同一批再传一次（和上传接口一样带上次认过的映射），对照表不用再填；报告零新建零更新，写入零新建零更新，库里一格不变", async () => {
    const 试 = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: 表们, 建议器: null, 已有映射: await 已认映射("excel") });
    批2 = 试.批次Id;
    const 报告 = 试.报告;
    // 上次填的都记着：同一张对照表再传回来，一项都不用改
    const 回 = 读回对照表({ 名: "对照表.csv", bytes: 表格 }, 报告, 成员们);
    expect([回.问题, 回.改了]).toEqual([[], 0]);
    expect(报告.预演?.合计).toMatchObject({ 新建: 0, 更新: 0, 冲突: 0, 失败: 0 });
    for (const e of 实体顺序) {
      const c = 报告.按类[e];
      expect([e, c.新建, c.更新, c.没变 + c.并入]).toEqual([e, 0, 0, c.待写]);
    }
    const r = await 写一批(批2, 我);
    expect(r).toMatchObject({ 完了: true, 新建: 0, 更新: 0, 冲突: 0, 失败: 0 });
    expect(r.跳过).toBe(报告.合计.跳过 + 合计(报告)("并入") + 合计(报告)("没变"));
    const 再 = await 拍();
    for (const k of Object.keys(导入后)) expect(再[k], k).toEqual(导入后[k]);
  });

  it("来回：两批倒着撤回，除日志表外每张表和导入前逐行一样", async () => {
    for (const id of [批2, 批1]) {
      const r = await 撤回一批(id, 我);
      expect(r, id).toMatchObject({ 状态: "reverted", 完了: true, 留下数: 0 });
    }
    const 撤后 = await 拍();
    const 去时间 = (行们: string[] = []) => 行们.map((r) => r.replace(/"updatedAt":"[^"]*"/, "")).sort();
    for (const k of Object.keys(导入前)) expect(去时间(撤后[k]), k).toEqual(去时间(导入前[k]));
  });
});
