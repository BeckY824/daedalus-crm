import { closeTestDatabases } from "./close-databases";
/**
 * 带额度()：托管版里所有花模型钱的入口共用的那一层（lib/tenant/ai-allowance.ts）。
 *
 * 2026-09-28 之前只有 /api/ai/stream 过闸门——起草话术、起草邀请、AI 解析、盯盘解读、
 * 粘贴切分五扇门都没上锁，托管版照样无限免费。这里钉三件事：
 *   1. 包装本身的收费契约：放行扣一次；没给出答案退；用户自己中断的不退；用完了 fn 根本不跑
 *   2. 每个 AI 动作真的接上了：额度用完时六个动作都回同一句话，一行业务代码都不跑
 *   3. 守卫：扫 src 里所有调模型的地方，新加的 AI 动作没套包装就红
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 状态 = vi.hoisted(() => ({ 当前工作区: null as string | null, requireUser调用: 0, 自带Key: false }));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// 工作区在设置里填没填自己的 Key。其余照真的走
vi.mock("@/lib/llm-config", async (orig) => ({
  ...(await orig<typeof import("@/lib/llm-config")>()),
  模型来源: async () => (状态.自带Key ? "ui" : "env"),
}));
vi.mock("@/lib/tenant/resolve", () => ({
  resolveCurrentTenant: async () =>
    状态.当前工作区 ? { workspaceId: 状态.当前工作区, slug: 状态.当前工作区, dbFile: `${状态.当前工作区}.db`, role: "ADMIN", writable: true } : null,
  clearTenantCache: () => {},
}));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    状态.requireUser调用++;
    return { id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" };
  },
}));

const 临时根 = path.join(os.tmpdir(), `crm-gate-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync(
    process.execPath,
    [path.resolve("node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const ddl = path.join(临时根, "control.sql");
  fs.writeFileSync(ddl, sql);
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync(process.argv[1]);
    db.exec(fs.readFileSync(process.argv[2], 'utf8'));
    db.close();
  `, path.join(临时根, "control.db"), ddl], { stdio: "pipe" });
});

afterAll(async () => {
  delete process.env.MULTI_TENANT;
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

const 天 = 86_400_000;
let 序号 = 0;

async function 建工作区(opts: { 付费?: boolean; 过期?: boolean } = {}) {
  const { control } = await import("@/lib/tenant/control");
  const id = `gate${序号++}`;
  await control.workspace.create({
    data: {
      id, slug: id, name: id, dbFile: `${id}.db`,
      status: opts.付费 ? "ACTIVE" : "TRIAL",
      trialEndsAt: new Date(Date.now() + (opts.过期 ? -天 : 3 * 天)),
      paidUntil: opts.付费 ? new Date(Date.now() + 300 * 天) : null,
    },
  });
  状态.当前工作区 = id;
  return id;
}

/** 把一个工作区的次数用光，返回用光之后闸门说的那句话 */
async function 用光(ws: string): Promise<string> {
  const { 扣一次额度 } = await import("@/lib/tenant/ai-allowance");
  for (let i = 0; i < 200; i++) {
    const r = await 扣一次额度(ws);
    if (!r.ok) return r.error;
  }
  throw new Error("200 次都没用光，账本规则变了？");
}

const 用掉 = async (ws: string) => (await (await import("@/lib/tenant/ai-allowance")).查额度(ws)).用掉;

beforeEach(async () => {
  process.env.MULTI_TENANT = "1";
  状态.当前工作区 = null;
  状态.requireUser调用 = 0;
  状态.自带Key = false;
  const { control } = await import("@/lib/tenant/control");
  await control.aiUsage.deleteMany({});
  await control.aiGrant.deleteMany({});
});

describe("带额度：收费契约", () => {
  it("放行时扣一次，fn 的结果原样回来", async () => {
    const { 带额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    const r = await 带额度("wakeup", async () => ({ ok: true as const, message: "你好" }));
    expect(r).toEqual({ ok: true, message: "你好" });
    expect(await 用掉(ws)).toBe(1);
  });

  it("fn 回 ok:false（客户不存在、模型没答上来）——人什么都没拿到，那一次退回去", async () => {
    const { 带额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    const r = await 带额度("parse", async () => ({ ok: false as const, error: "客户不存在" }));
    expect(r).toEqual({ ok: false, error: "客户不存在" });
    expect(await 用掉(ws)).toBe(0);
  });

  it("fn 抛异常：退回去，异常原样抛给调用方", async () => {
    const { 带额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    await expect(带额度("explain", async () => { throw new Error("上游超时"); })).rejects.toThrow("上游超时");
    expect(await 用掉(ws)).toBe(0);
  });

  it("用户自己中断的不退：上游已经在跑，钱是真花出去的（stream 的老约定）", async () => {
    const { 带额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    const 中断 = new AbortController();
    await expect(
      带额度("ask", async () => { 中断.abort(); throw new Error("aborted"); }, { 中断: 中断.signal }),
    ).rejects.toThrow("aborted");
    expect(await 用掉(ws)).toBe(1);
  });

  it("没中断的请求带着信号照样失败就退", async () => {
    const { 带额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    const r = await 带额度("ask", async () => ({ ok: false as const, error: "x" }), { 中断: new AbortController().signal });
    expect(r.ok).toBe(false);
    expect(await 用掉(ws)).toBe(0);
  });

  it("次数用完：fn 一下都不跑，回的是和 stream 一字不差的那句中文", async () => {
    const { 带额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    const 那句话 = await 用光(ws);
    const 之前 = await 用掉(ws);
    const fn = vi.fn(async () => ({ ok: true as const }));
    const r = await 带额度("invite", fn);
    expect(fn).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: false, error: 那句话 });
    expect(那句话).toContain("用完");
    // 10-03 起没有每日赠送：不许诺明天再送，给出订阅这条路
    expect(那句话).not.toContain("明天");
    expect(那句话).toContain("订阅");
    // 被拦下的那次不算用掉
    expect(await 用掉(ws)).toBe(之前);
  });

  it("试用到期：连第一次都不给", async () => {
    const { 带额度 } = await import("@/lib/tenant/ai-allowance");
    await 建工作区({ 过期: true });
    const fn = vi.fn(async () => ({ ok: true as const }));
    const r = await 带额度("paste", fn);
    expect(fn).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("试用已结束");
  });

  it("付费工作区不限次也不计数", async () => {
    const { 带额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区({ 付费: true });
    for (let i = 0; i < 5; i++) expect((await 带额度("brief", async () => ({ ok: true as const }))).ok).toBe(true);
    expect(await 用掉(ws)).toBe(0);
  });

  it("付费工作区失败了也不「退」：本来就没扣，退了等于白送一次", async () => {
    const { 带额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区({ 付费: true });
    await 带额度("parse", async () => ({ ok: false as const, error: "x" }));
    await expect(带额度("parse", async () => { throw new Error("上游超时"); })).rejects.toThrow();
    expect(await 用掉(ws)).toBe(0);
  });

  it("工作区填了自己的 Key：花的是他自己的钱——不扣、用完了也不拦、角标不挂「1 次」", async () => {
    const { 带额度 } = await import("@/lib/tenant/ai-allowance");
    const { 读AI计次 } = await import("@/lib/ai-meter");
    const ws = await 建工作区();
    await 用光(ws);
    const 之前 = await 用掉(ws);
    状态.自带Key = true;
    const fn = vi.fn(async () => ({ ok: true as const }));
    expect((await 带额度("wakeup", fn)).ok).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
    // 失败也不退：没扣过
    await 带额度("wakeup", async () => ({ ok: false as const, error: "x" }));
    expect(await 用掉(ws)).toBe(之前);
    expect((await 读AI计次({ 问余额: true })).计次).toBe(false);
    状态.自带Key = false;
    expect((await 读AI计次({ 问余额: true })).计次).toBe(true);
  });

  it("自部署 / 桌面端（没开 MULTI_TENANT）：一次都不扣，也不拦", async () => {
    const { 带额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    await 用光(ws);
    const 之前 = await 用掉(ws);
    delete process.env.MULTI_TENANT;
    const fn = vi.fn(async () => ({ ok: true as const }));
    expect((await 带额度("wakeup", fn)).ok).toBe(true);
    expect((await 带额度("wakeup", async () => ({ ok: false as const, error: "x" }))).ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    process.env.MULTI_TENANT = "1";
    expect(await 用掉(ws)).toBe(之前);
  });
});

describe("六个 AI 动作都接上了闸门", () => {
  it("零额度时空/坏输入先返回输入错误，无模型请求及账本变动（H019）", async () => {
    const ws = await 建工作区();
    await 用光(ws); const before = await 用掉(ws);
    const { parseFollowUpDraft, generateBrief } = await import("@/app/(app)/customers/[id]/ai");
    const { draftWakeup, explainWatchlist } = await import("@/app/(app)/dashboard/ai");
    const { draftInvite } = await import("@/app/(app)/channels/ai");
    const { 粘成表格 } = await import("@/app/(app)/customers/ai");
    const results = [
      await parseFollowUpDraft({ customerId: "c", text: "   " }),
      await parseFollowUpDraft(null as never),
      await generateBrief({ customerId: "   " }),
      await generateBrief({ customerId: "c", question: 42 as never }),
      await draftWakeup({ customerId: "c", reason: "" }),
      await explainWatchlist({ items: [] }),
      await explainWatchlist({ items: [null as never] }),
      await draftInvite({ customerId: 42 as never }),
      await 粘成表格("   "),
      await 粘成表格(42 as never),
      await 粘成表格("长".repeat(6001)),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).not.toMatch(/用完|额度/);
    }
    const { POST } = await import("@/app/api/ai/stream/route");
    for (const body of [null, [], { mode: "agent", question: "   " }, { mode: "agent", question: 42 }]) {
      const r = await POST(new Request("http://qa.test/api/ai/stream", { method: "POST", body: JSON.stringify(body) }));
      expect(r.status).toBe(400);
    }
    expect(await 用掉(ws)).toBe(before);
    expect(状态.requireUser调用).toBe(0);
  });

  it("次数用完时每个动作都回同一句话，而且一行业务代码都没跑（连 requireUser 都没到）", async () => {
    const ws = await 建工作区();
    const 那句话 = await 用光(ws);
    const { parseFollowUpDraft, generateBrief } = await import("@/app/(app)/customers/[id]/ai");
    const { draftWakeup, explainWatchlist } = await import("@/app/(app)/dashboard/ai");
    const { draftInvite } = await import("@/app/(app)/channels/ai");
    const { 粘成表格 } = await import("@/app/(app)/customers/ai");
    const 结果 = {
      AI解析: await parseFollowUpDraft({ customerId: "c", text: "刚跟家长聊了二十分钟" }),
      简报: await generateBrief({ customerId: "c" }),
      起草话术: await draftWakeup({ customerId: "c", reason: "沉睡 20 天" }),
      盯盘解读: await explainWatchlist({ items: [{ customerId: "c", reason: "x" }] }),
      起草邀请: await draftInvite({ customerId: "c" }),
      粘贴切分: await 粘成表格("张三 13800000001"),
    };
    for (const [名, r] of Object.entries(结果)) {
      expect(r, 名).toEqual({ ok: false, error: 那句话 });
    }
    expect(状态.requireUser调用).toBe(0);
  });

  it("动作自己拒掉的（没粘东西）那次退回去——人什么都没拿到", async () => {
    const ws = await 建工作区();
    const { 粘成表格 } = await import("@/app/(app)/customers/ai");
    const r = await 粘成表格("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("先把名单");
    expect(await 用掉(ws)).toBe(0);
  });
});

/* ---------------- 守卫：调模型的地方都得套 带额度 ---------------- */

const 源码根 = path.resolve(__dirname, "../src");

function 所有源码(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "generated" ? [] : 所有源码(p);
    return /\.(ts|tsx)$/.test(d.name) ? [p] : [];
  });
}

const 相对 = (p: string) => path.relative(源码根, p).split(path.sep).join("/");

/**
 * 直接发模型请求的写法：lib/llm.ts 的几个入口、agent，以及绕过它们自己 fetch 上游 /chat/completions 的。
 * 判断类（lib/jev 的 问选择）不在这里：它不进次数账本，见 lib/jev/client.ts 开头
 */
const 模型调用 = /\b(chatJSON|chatMessagesJSON|chatTools|chatTextStream|runAgent|testLlm)\s*\(|fetch\(\s*`[^`]*\/chat\/completions/;

/** 这些文件就是模型调用的实现本身，由上面的入口来扣 */
const 底层 = (f: string) => f === "lib/llm.ts" || f.startsWith("lib/agent/");

/**
 * 调了模型却**故意不扣**的地方，每一条写清理由。加一条之前先想想：它花的是不是我们的钱？
 */
const 不扣: Record<string, string> = {
  // 设置页「测试连接」：发一句最小请求验证管理员自己填的地址和 Key。
  // 平台那把 Key 只肯发给它自己的地址（lib/llm-config.ts 的 resolveLlmConfigForTest），共享工作区直接拒
  "app/(app)/settings/actions.ts#testLlmSettings": "连通性测试，不是 AI 功能",
  // 桌面端的云端网关：按账号扣（lib/tenant/credits.ts 的 按问题扣一次），不是工作区账本
  "app/api/gateway/v1/chat/completions/route.ts": "网关自己按账号扣",
};

type 函数段 = { 名: string; 导出: boolean; 体: string };

/** 按顶层 function 声明切段。粗，但这几份文件都是一个个顶层函数，够用 */
function 切函数(src: string): 函数段[] {
  const 头 = /^(export\s+)?(async\s+)?function\s+([^\s(<]+)/gm;
  const 位置: { i: number; 名: string; 导出: boolean }[] = [];
  for (const m of src.matchAll(头)) 位置.push({ i: m.index!, 名: m[3], 导出: Boolean(m[1]) });
  return 位置.map((p, k) => ({ 名: p.名, 导出: p.导出, 体: src.slice(p.i, 位置[k + 1]?.i ?? src.length) }));
}

describe("守卫：花模型钱的入口都套了 带额度", () => {
  const 文件们 = 所有源码(源码根)
    .map((p) => ({ f: 相对(p), src: fs.readFileSync(p, "utf8") }))
    .filter(({ f, src }) => !底层(f) && 模型调用.test(src));

  it("扫得到东西（扫描本身没坏）", () => {
    const 名 = 文件们.map((x) => x.f);
    expect(名).toContain("app/(app)/dashboard/ai.ts");
    expect(名).toContain("app/api/ai/stream/route.ts");
  });

  it("Server Action：每个导出的、会走到模型调用的函数都经过 带额度", () => {
    const 漏的: string[] = [];
    for (const { f, src } of 文件们.filter((x) => /^["']use server["']/m.test(x.src))) {
      const 段 = 切函数(src);
      // 函数名多是中文，\b 认不出中文的词边界，所以用反向断言
      const 会调模型 = (s: 函数段, 走过 = new Set<string>()): boolean => {
        if (走过.has(s.名)) return false;
        走过.add(s.名);
        if (模型调用.test(s.体)) return true;
        return 段.some((o) => o !== s && new RegExp(`(?<![\\w$\\u4e00-\\u9fff])${o.名}\\s*\\(`).test(s.体) && 会调模型(o, 走过));
      };
      for (const s of 段.filter((x) => x.导出)) {
        if (!会调模型(s)) continue;
        if (`${f}#${s.名}` in 不扣) continue;
        if (!/带额度\(/.test(s.体)) 漏的.push(`${f}#${s.名}`);
      }
    }
    expect(漏的, "这些动作会调模型却没套 带额度（lib/tenant/ai-allowance.ts）——托管版里它们不扣次数").toEqual([]);
  });

  it("调模型的 Server Action 文件只许用 function 声明导出——上面那条按 function 切段，箭头函数会被漏过去", () => {
    const 箭头 = 文件们
      .filter((x) => /^["']use server["']/m.test(x.src))
      .flatMap(({ f, src }) => [...src.matchAll(/^export\s+const\s+([^\s=:]+)\s*[:=]/gm)].map((m) => `${f}#${m[1]}`));
    expect(箭头, "改成 export async function，守卫才认得出它有没有套 带额度").toEqual([]);
  });

  it("其余调模型的文件（路由、lib）：要么整份套了 带额度，要么在「不扣」里写了理由", () => {
    const 漏的 = 文件们
      .filter((x) => !/^["']use server["']/m.test(x.src))
      .filter(({ f, src }) => !(f in 不扣) && !/带额度\(/.test(src))
      .map((x) => x.f);
    expect(漏的).toEqual([]);
  });

  it("带额度 的用途键都登记在 AI_FEATURES 里，而且和同一份文件里 recordAiUse 记的是同一个键", async () => {
    const { AI_FEATURES } = await import("@/lib/ai-usage");
    const 问题: string[] = [];
    for (const { f, src } of 所有源码(源码根).map((p) => ({ f: 相对(p), src: fs.readFileSync(p, "utf8") }))) {
      if (f === "lib/tenant/ai-allowance.ts") continue;
      const 扣的 = [...src.matchAll(/带额度\(\s*"([^"]+)"/g)].map((m) => m[1]);
      if (!扣的.length) continue;
      const 记的 = new Set([...src.matchAll(/recordAiUse\(\s*\w+,\s*"([^"]+)"/g)].map((m) => m[1]));
      for (const k of 扣的) {
        if (!(k in AI_FEATURES)) 问题.push(`${f}：用途键「${k}」没登记在 AI_FEATURES`);
        if (!记的.has(k)) 问题.push(`${f}：扣的是「${k}」，但这份文件里 recordAiUse 没记这个键`);
      }
    }
    expect(问题).toEqual([]);
  });

  it("「不扣」名单里的每一条都还真的存在——删掉的入口别留着豁免", () => {
    for (const k of Object.keys(不扣)) {
      const [f, 名] = k.split("#");
      const src = fs.readFileSync(path.join(源码根, f), "utf8");
      expect(模型调用.test(src), k).toBe(true);
      if (名) expect(src, k).toMatch(new RegExp(`export async function ${名}\\b`));
    }
  });
});


it("停用工作区不能借付费或自带Key绕过AI闸门", async () => {
  const { 带额度, 扣一次额度 } = await import("@/lib/tenant/ai-allowance");
  const { control } = await import("@/lib/tenant/control");
  const ws = await 建工作区({ 付费: true });
  await control.workspace.update({ where: { id: ws }, data: { status: "SUSPENDED" } });
  const fn = vi.fn(async () => ({ ok: true as const }));
  expect((await 扣一次额度(ws)).ok).toBe(false);
  expect((await 带额度("ask", fn)).ok).toBe(false);
  状态.自带Key = true;
  expect((await 带额度("ask", fn)).ok).toBe(false);
  expect(fn).not.toHaveBeenCalled();
});
