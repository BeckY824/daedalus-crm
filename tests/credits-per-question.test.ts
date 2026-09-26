import { closeTestDatabases } from "./close-databases";
/**
 * 一个问题扣一次，上游失败退还。
 *
 * 这是**收费契约**，不是优化：价格页写的是「一次提问算一次」，而代码一直按
 * 网关请求扣——agent 回答一个问题要跑好几步（lib/agent/run.ts 的 MAX_STEPS = 6），
 * 每步一次请求。2026-09-21 实测：6 个提问吃掉 39 次额度，「送 30 次」实际只够四五个问题。
 *
 * 四条，每一条都直接对着钱：
 *   1. 同一个问题的后面几步**不扣**
 *   2. 没带问题编号的老客户端**照旧每次扣**（不能因为改口径把老版本坑了）
 *   3. 上游失败**退一次**，而且**只退一次**（同一个问题重试几次也只退一次）
 *   4. 退过之后同一个编号再来，算新的一次——他上一次什么都没拿到
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-charge-${process.pid}`);

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

let 序号 = 0;
/** 造一个桌面端账号，并把注册赠送结掉——账号那一侧的账本就是这么起头的 */
async function 建账号() {
  const { control } = await import("@/lib/tenant/control");
  const id = `acc${序号++}`;
  await control.account.create({ data: { id, email: `${id}@t.test`, password: "x", name: id } });
  const 账本 = await import("@/lib/tenant/credits");
  await 账本.赠送({ kind: "account", id }, { amount: 账本.注册赠送, reason: "signup", key: `${id}-signup` });
  return { kind: "account" as const, id };
}

/**
 * **断言看「用掉几次」，不看「还剩几次」。**
 * 扣一次 里会顺带结算每日赠送（余额低于 30 时当天补 3），于是「还剩」会被抬高，
 * 而这组测试要钉的正是「扣了几次」本身。
 */
const 用掉 = async (owner: { kind: "account"; id: string }) => (await import("@/lib/tenant/credits")).用掉次数(owner);

beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.aiCharge.deleteMany({});
  await control.accountAiUsage.deleteMany({});
  await control.accountAiGrant.deleteMany({});
  await control.account.deleteMany({});
});

describe("一个问题扣一次", () => {
  it("同一个问题跑六步，只扣一次", async () => {
    const { 按问题扣一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    const rid = "q-1";
    const 第一步 = await 按问题扣一次(owner, rid);
    expect(第一步.ok && 第一步.扣了).toBe(true);
    for (let i = 0; i < 5; i++) {
      const r = await 按问题扣一次(owner, rid);
      expect(r.ok && r.扣了, `第 ${i + 2} 步不该再扣`).toBe(false);
    }
    expect(await 用掉(owner)).toBe(1);
  });

  it("两个问题就是两次", async () => {
    const { 按问题扣一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    await 按问题扣一次(owner, "q-a");
    await 按问题扣一次(owner, "q-a");
    await 按问题扣一次(owner, "q-b");
    expect(await 用掉(owner)).toBe(2);
  });

  it("**没带编号的老客户端照旧每次扣**——改口径不能把老版本坑了", async () => {
    const { 按问题扣一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    for (let i = 0; i < 3; i++) {
      const r = await 按问题扣一次(owner, null);
      expect(r.ok && r.扣了).toBe(true);
    }
    expect(await 用掉(owner)).toBe(3);
  });

  it("一个问题跑太多步（超过封顶）就当新的一个问题再扣，而不是拒绝", async () => {
    const { 按问题扣一次, 每问最多步 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    const rid = "q-loop";
    for (let i = 0; i < 每问最多步; i++) await 按问题扣一次(owner, rid);
    expect(await 用掉(owner)).toBe(1);
    const 再来 = await 按问题扣一次(owner, rid);
    // 封顶之后不是把人挡在门外（那会打断正在等的回答），而是再扣一次
    expect(再来.ok && 再来.扣了).toBe(true);
    expect(await 用掉(owner)).toBe(2);
  });

  it("次数用完时照样拦得住，带不带编号都一样", async () => {
    const { 按问题扣一次, 余额 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    // 一直问到拦下为止（上限会被每日赠送抬一点，所以按结果循环而不是按固定次数）
    let 挡住了 = false;
    for (let i = 0; i < 200 && !挡住了; i++) {
      const r = await 按问题扣一次(owner, `q${i}`);
      挡住了 = !r.ok;
    }
    expect(挡住了, "问到上限也没被拦下").toBe(true);
    expect((await 余额(owner)).还剩).toBe(0);
  });
});

describe("上游失败退还", () => {
  it("退一次，而且只退一次", async () => {
    const { 按问题扣一次, 退这一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    const rid = "q-fail";
    const 扣 = await 按问题扣一次(owner, rid);
    expect(await 用掉(owner)).toBe(1);
    await 退这一次(owner, rid, 扣.ok && 扣.扣了);
    expect(await 用掉(owner)).toBe(0);
    // 重试三次都调到退：**幂等**，不能退成负的
    await 退这一次(owner, rid, true);
    await 退这一次(owner, rid, true);
    expect(await 用掉(owner)).toBe(0);
  });

  it("没扣过的那几步不退", async () => {
    const { 按问题扣一次, 退这一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    const rid = "q-step";
    await 按问题扣一次(owner, rid);
    const 第二步 = await 按问题扣一次(owner, rid);
    await 退这一次(owner, rid, 第二步.ok && 第二步.扣了);
    expect(await 用掉(owner)).toBe(1);
  });

  it("退过之后同一个编号再来，算新的一次——上一次他什么都没拿到", async () => {
    const { 按问题扣一次, 退这一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    const rid = "q-retry";
    const a = await 按问题扣一次(owner, rid);
    await 退这一次(owner, rid, a.ok && a.扣了);
    const b = await 按问题扣一次(owner, rid);
    expect(b.ok && b.扣了).toBe(true);
    expect(await 用掉(owner)).toBe(1);
  });

  it("没带编号的那条路也退得掉", async () => {
    const { 按问题扣一次, 退这一次 } = await import("@/lib/tenant/credits");
    const owner = await 建账号();
    const r = await 按问题扣一次(owner, null);
    await 退这一次(owner, null, r.ok && r.扣了);
    expect(await 用掉(owner)).toBe(0);
  });
});

describe("问题编号的规整", () => {
  it("uuid、cuid、随机串都收；空的、太长的、带路径分隔符的一律当没给", async () => {
    const { 规整请求id } = await import("@/lib/tenant/credits");
    expect(规整请求id("0199f8c1-2a3b-7c4d-8e5f-60718293a4b5")).toBeTruthy();
    expect(规整请求id("cmu2cbqxw0001r1011m452vsc")).toBeTruthy();
    expect(规整请求id("a_b-c123")).toBe("a_b-c123");
    for (const 坏 of ["", "   ", "a/b", "a b", "../x", "x".repeat(65), "中文", "a;drop"]) {
      expect(规整请求id(坏), `${JSON.stringify(坏)} 不该被收下`).toBeNull();
    }
  });
});

describe("守卫：三处口径必须一致", () => {
  it("控制面建了 AiCharge 和那条唯一索引——没有它幂等就是空话", () => {
    const sql = fs.readFileSync(path.resolve(__dirname, "../control-migrations/012-ai-charge.sql"), "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "AiCharge"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "AiCharge_owner_request_key"');
    const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/control.prisma"), "utf8");
    expect(schema).toContain("model AiCharge");
    expect(schema).toContain("@@unique([ownerKind, ownerId, requestId])");
  });

  it("网关认的头、llm.ts 发的头，两边是同一对名字", () => {
    const 网关 = fs.readFileSync(path.resolve(__dirname, "../src/app/api/gateway/v1/chat/completions/route.ts"), "utf8");
    const llm = fs.readFileSync(path.resolve(__dirname, "../src/lib/llm.ts"), "utf8");
    expect(网关).toContain('req.headers.get("x-question-id")');
    expect(网关).toContain('req.headers.get("x-feature")');
    expect(llm).toContain('额外头["X-Question-Id"]');
    expect(llm).toContain('额外头["X-Feature"]');
  });

  it("网关在上游出错的两条路上都退了", () => {
    const 网关 = fs.readFileSync(path.resolve(__dirname, "../src/app/api/gateway/v1/chat/completions/route.ts"), "utf8");
    // 连不上 / 超时那一条，和上游回了非 2xx 那一条
    expect((网关.match(/退这一次\(owner, 问题id, 扣\.扣了\)/g) ?? []).length).toBe(2);
  });

  it("agent 一个问题只生成一个编号，三处调用都带着它", () => {
    const run = fs.readFileSync(path.resolve(__dirname, "../src/lib/agent/run.ts"), "utf8");
    expect((run.match(/const 问题id = randomUUID\(\)/g) ?? []).length).toBe(1);
    // 每步决策、原生工具那一轮、最终回答
    expect((run.match(/requestId: 问题id/g) ?? []).length).toBe(3);
  });

  it("网页端那条路失败也退，但用户自己中断的不退", () => {
    const 路由 = fs.readFileSync(path.resolve(__dirname, "../src/app/api/ai/stream/route.ts"), "utf8");
    expect(路由).toContain("扣过了 && !req.signal.aborted");
    expect(路由).toContain("退一次额度()");
  });
});
