/**
 * r2-ai · 六、粘贴导入的 AI 切分：模型切错了，人能不能在预览里看出来。
 *
 * 两条核对（lib/import/paste.ts 的 核对）：「每一格必须是原文子串」抓编造，「原文里的手机号表里都得有」抓漏人。
 * tests/import-paste.test.ts 已经钉了它们管得住的那些；这里专找**它们管不住的**：
 * 号码配错了人、没留手机号的人被漏掉、名单太长被截断。最后一组走一遍桌面端整条线（粘成表格 → 网关 → 假上游）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { 核对, 粘贴行数上限, 粘贴字数上限 } from "@/lib/import/paste";
import { closeTestDatabases } from "./close-databases";
import { resetDb } from "./reset";
import {
  建控制库, 网关环境, 建账号带令牌, 用掉, 装桌面端, 拆桌面端, 标准凭据, 接线, 是人话, 回JSON, 回文本,
} from "./r2-ai-harness";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

const 原文 = [
  "李老师今天推荐了三位：",
  "赵一 13800000001 平川科技，想下周看演示",
  "钱二 13800000002 长河教育",
  "孙三，没留电话，微信 sunsan_88，远山资本",
].join("\n");
const 表头 = ["姓名", "手机号", "公司", "备注"];

describe("核对管得住的（回归）", () => {
  it("编了一个原文里没有的人：整行清空、列进「编造」", () => {
    const r = 核对({ 表头, 数据: [["赵一", "13800000001", "平川科技", ""], ["周四", "13900000004", "某某科技", ""]] }, 原文);
    expect(r.数据.map((x) => x[0])).toEqual(["赵一"]);
    expect(r.编造.map((x) => x.值)).toEqual(expect.arrayContaining(["周四", "13900000004"]));
  });

  it("漏了一个有手机号的人：报进「漏掉」", () => {
    const r = 核对({ 表头, 数据: [["赵一", "13800000001", "平川科技", ""]] }, 原文);
    expect(r.漏掉).toEqual(["13800000002"]);
  });

  it("两个人被合成一行（号码只留了一个）：另一个号码报进「漏掉」", () => {
    const r = 核对({ 表头, 数据: [["赵一、钱二", "13800000001", "平川科技", ""]] }, 原文);
    expect(r.漏掉).toEqual(["13800000002"]);
  });

  it("模型把号码当数字给回来：照样比对，不误报", () => {
    const r = 核对({ 表头, 数据: [["赵一", 13800000001 as unknown as string, "平川科技", ""], ["钱二", "13800000002", "长河教育", ""]] }, 原文);
    expect(r.编造).toEqual([]);
    expect(r.数据[0][1]).toBe("13800000001");
  });
});

describe("核对管不住的", () => {
  it.skip("【下一版】【坏】张冠李戴：赵一和钱二的号码对调了——两条核对都过，预览里没有任何提示", () => {
    const r = 核对({ 表头, 数据: [["赵一", "13800000002", "平川科技", ""], ["钱二", "13800000001", "长河教育", ""], ["孙三", "", "远山资本", "微信 sunsan_88"]] }, 原文);
    const 有提示 = r.编造.length > 0 || r.漏掉.length > 0;
    expect(有提示, "导进去之后，打给赵一的电话会接到钱二").toBe(true);
  });

  it.skip("【下一版】【坏】张冠李戴：公司配错了人（钱二配成「平川科技」）——同样看不出来", () => {
    const r = 核对({ 表头, 数据: [["赵一", "13800000001", "长河教育", ""], ["钱二", "13800000002", "平川科技", ""]] }, 原文);
    expect(r.编造.length + r.漏掉.length, "公司对调了也是原文里的字").toBeGreaterThan(0);
  });

  it.skip("【下一版】【坏】漏人：没留手机号的孙三被漏了——「漏掉」只看手机号，没有提示", () => {
    const r = 核对({ 表头, 数据: [["赵一", "13800000001", "平川科技", ""], ["钱二", "13800000002", "长河教育", ""]] }, 原文);
    expect(r.漏掉.length, "原文里有三个人，表里两个").toBeGreaterThan(0);
  });

  it("编了一个原文里「凑得出来」的名字（取了别人名字里的字）：单字片段照样过核对", () => {
    const r = 核对({ 表头, 数据: [["赵一", "13800000001", "平川科技", ""], ["钱", "13800000002", "教育", ""]] }, 原文);
    // 只记现状：「钱」「教育」都是原文子串，抓不到；后果是钱二的名字被截成一个字（人在预览里看得见）
    expect(r.编造).toEqual([]);
  });
});

describe("超长名单", () => {
  const 长原文 = Array.from({ length: 250 }, (_, i) => `学员${i} 139${String(i).padStart(8, "0")}`).join("\n");
  const 长表 = { 表头: ["姓名", "手机号"], 数据: Array.from({ length: 250 }, (_, i) => [`学员${i}`, `139${String(i).padStart(8, "0")}`]) };

  it("模型给了 250 行：收 200 行，说清被截了多少；被截掉那 50 个号码也报进「漏掉」", () => {
    const r = 核对(长表, 长原文);
    expect(r.数据).toHaveLength(粘贴行数上限);
    expect(r.截断了?.行).toBe(250);
    expect(r.漏掉).toHaveLength(50);
  });

  it("超过字数上限：不调模型，直接说「存成 Excel」", async () => {
    await resetDb();
    const { 粘成表格 } = await import("@/app/(app)/customers/ai");
    const 长 = "赵一 13800000001\n".repeat(Math.ceil(粘贴字数上限 / 10));
    expect(长.trim().length).toBeGreaterThan(粘贴字数上限);
    const r = await 粘成表格(长);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("Excel");
  });
});

describe("桌面端整条线：粘成表格 → 网关 → 假上游", () => {
  const 根 = path.join(os.tmpdir(), `r2-ai-paste-${process.pid}`);
  let 目录 = "";
  let 账号: Awaited<ReturnType<typeof 建账号带令牌>>;
  beforeAll(() => 建控制库(根));
  afterAll(async () => {
    await closeTestDatabases(根);
    fs.rmSync(根, { recursive: true, force: true });
  });
  beforeEach(async () => {
    网关环境();
    (await import("@/lib/ai-quota")).resetAiQuota();
    (await import("@/lib/rate-limit")).重置限流();
    (await import("@/lib/llm")).重置模型探测();
    await resetDb();
    const { prisma } = await import("@/lib/prisma");
    await prisma.user.create({ data: { id: "tester-id", email: "t@t", name: "测试员", role: "ADMIN", password: "x" } });
    账号 = await 建账号带令牌();
    目录 = 装桌面端(标准凭据(账号.token));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    拆桌面端(目录);
  });
  const 粘 = async (s: string) => (await import("@/app/(app)/customers/ai")).粘成表格(s);

  it("模型编了一个人、漏了一个人：预览里两样都报出来，只扣 1 次", async () => {
    const line = 接线({ 上游: () => 回文本(JSON.stringify({ 表头, 数据: [["赵一", "13800000001", "平川科技", ""], ["周四", "13900000004", "", ""]] })) });
    expect(line.网关).toHaveLength(0);
    const r = await 粘(原文);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(line.网关[0].feature).toBe("paste");
    expect(r.编造.map((x) => x.值)).toContain("周四");
    expect(r.漏掉).toEqual(["13800000002"]);
    expect(await 用掉(账号.acc.id)).toBe(1);
  });

  it("长名单超出网关预算：明确分批处理且不虚报提高预算，不保留扣次", async () => {
    const 线 = 接线({
      上游: () =>
        回JSON({
          choices: [{ message: { content: '{"表头":["姓名","手机号"],"数据":[["学员0","139' }, finish_reason: "length" }],
          usage: { completion_tokens: 8000, completion_tokens_details: { reasoning_tokens: 2400 } },
        }),
    });
    const 长 = Array.from({ length: 150 }, (_, i) => `学员${i} 139${String(i).padStart(8, "0")} 某某公司第${i}分部`).join("\n").slice(0, 粘贴字数上限);
    const r = await 粘(长);
    expect(r.ok).toBe(false);
    const msg = r.ok ? "" : r.error;
    expect(线.上游.length).toBe(2);
    const 第二次实际预算 = Number(线.上游[1].body.max_tokens);
    expect(第二次实际预算, "网关夹到 8000").toBeLessThanOrEqual(8000);
    expect(await 用掉(账号.acc.id)).toBe(0);
    // 说「已提高预算，请重试」时，第二次转到上游的预算其实并没有比第一次多
    expect(第二次实际预算 > Number(线.上游[0].body.max_tokens) || !/提高预算|请重试/.test(msg), `界面上会显示：${msg}`).toBe(true);
  });

  it("模型一个人都没切出来：给出提示且桌面端不扣次", async () => {
    接线({ 上游: () => 回文本(JSON.stringify({ 表头: ["姓名"], 数据: [] })) });
    const r = await 粘(原文);
    expect(r.ok).toBe(false);
    expect(是人话(r.ok ? "" : r.error)).toBe(true);
    expect(await 用掉(账号.acc.id)).toBe(0);
  });

  it("模型返回的不是表（缺「数据」）：说人话，不往下游漏", async () => {
    接线({ 上游: () => 回文本(JSON.stringify({ rows: [["赵一"]] })) });
    const r = await 粘(原文);
    expect(r.ok).toBe(false);
    expect(是人话(r.ok ? "" : r.error), r.ok ? "" : r.error).toBe(true);
  });
});
