import { closeTestDatabases } from "./close-databases";
/**
 * 运营通知（lib/ops-notices.ts + /api/ops/notices，2026-10-02）。
 *
 * 先钉隔离：**只有运营名单里的账号拿得到**——别人的令牌 403 而且一个字都不给，没配名单 404。
 * 再钉内容：第一次问不补旧账；新注册、新反馈各一条；一堆同类并成一条；
 * 用量超线才报、按提问（AiCharge）不按步数；since 最多往回 24 小时；进门后的跳转只认 /admin 下的路径。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-ops-notices-${process.pid}`);

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

beforeEach(async () => {
  process.env.OPS_ACCOUNTS = "boss@example.com";
  const { control } = await import("@/lib/tenant/control");
  await control.aiCharge.deleteMany({});
  await control.aiCall.deleteMany({});
  await control.feedback.deleteMany({});
  const { 重置限流 } = await import("@/lib/rate-limit");
  重置限流();
});
afterEach(() => {
  delete process.env.OPS_ACCOUNTS;
});

let 序号 = 0;
async function 建账号(email: string, name = `人${序号++}`) {
  const { createAccount } = await import("@/lib/tenant/accounts");
  return createAccount({ target: { kind: "email", value: email }, password: "abcd1234", name });
}
async function 发令牌(accountId: string) {
  const { 签发 } = await import("@/lib/tenant/device-token");
  return (await 签发(accountId, "某台机器")).token;
}
const 问 = async (token: string, since?: string) => {
  const { GET } = await import("@/app/api/ops/notices/route");
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  return GET(new Request(`https://app.example.com/api/ops/notices${q}`, { headers: { Authorization: `Bearer ${token}` } }));
};

describe("隔离：只有运营账号拿得到", () => {
  it("名单外的账号 403，正文里没有任何事件", async () => {
    await 建账号(`newbie${Date.now()}@example.com`, "刚注册的");
    const 路人 = await 建账号(`someone${Date.now()}@example.com`);
    const r = await 问(await 发令牌(路人.id), new Date(Date.now() - 3600_000).toISOString());
    expect(r.status).toBe(403);
    const 文 = await r.text();
    expect(文).not.toContain("刚注册的");
    expect(文).not.toContain("事件");
  });
  it("令牌不对 401；没配名单 404", async () => {
    expect((await 问("dt_wrong_token_for_tests")).status).toBe(401);
    delete process.env.OPS_ACCOUNTS;
    const 某人 = await 建账号(`x${Date.now()}@example.com`);
    expect((await 问(await 发令牌(某人.id))).status).toBe(404);
  });
  it("运营账号：第一次不带 since 只回 now；带 since 拿到新注册", async () => {
    const boss = (await import("@/lib/tenant/control")).control.account.findFirst({ where: { email: "boss@example.com" } });
    const b = (await boss) ?? (await 建账号("boss@example.com", "老板"));
    const t = await 发令牌(b.id);
    const 首 = await (await 问(t)).json();
    expect(首.事件).toEqual([]);
    expect(typeof 首.now).toBe("string");
    /*
      createdAt 是 Prisma 引擎按它自己的钟盖的，Windows 上和 JS 的钟能差十几毫秒：since 只往前留 1 毫秒时，新号会落到 since 之前或 now 之后（10-07 Windows 打包机红过）。
      所以按 JS 的钟把它的 createdAt 写死在 since 和 now 之间；前面几条用例建的号挪到很早，免得超过 3 条被并成「新增 N 个用户」
    */
    const { control } = await import("@/lib/tenant/control");
    const 新 = await 建账号(`fresh${Date.now()}@example.com`, "新来的");
    await control.account.updateMany({ where: { id: { not: 新.id } }, data: { createdAt: new Date(0) } });
    await control.account.update({ where: { id: 新.id }, data: { createdAt: new Date(Date.now() - 500) } });
    const 起 = new Date(Date.now() - 1000).toISOString();
    const 次 = await (await 问(t, 起)).json();
    expect(次.事件).toContainEqual(expect.objectContaining({ key: `注册:${新.id}`, kind: "注册", 标题: "新用户：新来的", path: `/admin/users/${新.id}` }));
  });
});

describe("内容", () => {
  it("新反馈一条一条；超过 3 条并成一条", async () => {
    const { control } = await import("@/lib/tenant/control");
    const { 读运营通知 } = await import("@/lib/ops-notices");
    const now = new Date();
    const 起 = new Date(now.getTime() - 60_000).toISOString();
    await control.feedback.create({ data: { body: "导入\n卡住了", who: "张三 · z@x.com", at: new Date(now.getTime() - 1000) } });
    let r = await 读运营通知(起, now);
    const 反馈 = r.事件.filter((e) => e.kind === "反馈");
    expect(反馈).toHaveLength(1);
    expect(反馈[0]).toMatchObject({ 标题: "新反馈：张三 · z@x.com", 正文: "导入 卡住了", path: "/admin/feedback" });
    for (let i = 0; i < 4; i++) await control.feedback.create({ data: { body: `第${i}条`, at: new Date(now.getTime() - 500) } });
    r = await 读运营通知(起, now);
    expect(r.事件.filter((e) => e.kind === "反馈")).toEqual([expect.objectContaining({ 标题: "5 条新反馈" })]);
  });

  it("新团队待开通（10-07）：一个团队一条、写团队名和老板、点开去团队同步页；已开通的、since 之前建的不报；不并条", async () => {
    const { control } = await import("@/lib/tenant/control");
    const { 读运营通知 } = await import("@/lib/ops-notices");
    const { 去处 } = await import("../desktop/ops-notices.js");
    const 老板 = await 建账号("team-owner@example.com", "老板甲");
    const now = new Date();
    const 起 = new Date(now.getTime() - 60_000).toISOString();
    const 建 = (name: string, at: Date, active = false) =>
      control.syncTeam.create({ data: { name, ownerAccountId: 老板.id, joinSecretHash: "x", active, createdAt: at } });
    await 建("早就建了的", new Date(now.getTime() - 3600_000));
    await 建("已经开通的", new Date(now.getTime() - 1000), true);
    for (const n of ["Win测试队", "二队", "三队", "四队"]) await 建(n, new Date(now.getTime() - 1000));
    const r = await 读运营通知(起, now);
    const 团队 = r.事件.filter((e) => e.kind === "团队");
    expect(团队.map((e) => e.标题)).toEqual(["新团队待开通：Win测试队", "新团队待开通：二队", "新团队待开通：三队", "新团队待开通：四队"]);
    expect(团队[0]).toMatchObject({ 正文: "team-owner@example.com 建的 · 点开去运营台「团队同步」开通", path: "/admin/sync" });
    // 壳那头点通知认得这个去处
    expect(去处(团队[0].path)).toBe("/admin/sync");
    await control.syncTeam.deleteMany({});
  });

  it("用量：一小时提问数超线才报，按 AiCharge 数；同一个钟头键相同", async () => {
    const { control } = await import("@/lib/tenant/control");
    const { 读运营通知 } = await import("@/lib/ops-notices");
    const 人 = await 建账号(`heavy${Date.now()}@example.com`);
    const now = new Date();
    const 起 = new Date(now.getTime() - 60_000).toISOString();
    const 加 = (n: number, 前缀: string) =>
      control.aiCharge.createMany({ data: Array.from({ length: n }, (_, i) => ({ ownerKind: "account", ownerId: 人.id, requestId: `${前缀}${i}`, at: new Date(now.getTime() - 10_000) })) });
    await 加(29, "a");
    expect((await 读运营通知(起, now, {})).事件.filter((e) => e.kind === "用量")).toHaveLength(0);
    await 加(1, "b");
    const 一 = (await 读运营通知(起, now, {})).事件.filter((e) => e.kind === "用量");
    expect(一).toHaveLength(1);
    expect(一[0]).toMatchObject({ 标题: `用量异常：${人.email}`, 正文: "近一小时问了 AI 30 次", path: `/admin/users/${人.id}` });
    const 二 = (await 读运营通知(起, new Date(now.getTime() + 1000), {})).事件.filter((e) => e.kind === "用量");
    expect(二[0].key).toBe(一[0].key);
    // 线可调
    expect((await 读运营通知(起, now, { OPS_ALERT_ASKS_PER_HOUR: "100" })).事件.filter((e) => e.kind === "用量")).toHaveLength(0);
  });

  it("用量：今天 token 超线", async () => {
    const { control } = await import("@/lib/tenant/control");
    const { 读运营通知 } = await import("@/lib/ops-notices");
    const 人 = await 建账号(`tok${Date.now()}@example.com`);
    const now = new Date();
    await control.aiCall.create({ data: { ownerKind: "account", ownerId: 人.id, model: "m", inputTokens: 900_000, outputTokens: 100_000, at: new Date(now.getTime() - 1000) } });
    const r = await 读运营通知(new Date(now.getTime() - 60_000).toISOString(), now, {});
    expect(r.事件.filter((e) => e.kind === "用量")).toEqual([expect.objectContaining({ 正文: "今天已用 100 万 token" })]);
  });

  it("since 最多往回 24 小时，未来的拉回到 now，乱写的当没给", async () => {
    const { 规整起点 } = await import("@/lib/ops-notices");
    const now = new Date("2026-10-02T12:00:00Z");
    expect(规整起点("2026-09-01T00:00:00Z", now)!.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(规整起点("2026-10-03T00:00:00Z", now)!.toISOString()).toBe(now.toISOString());
    expect(规整起点("乱写", now)).toBeNull();
  });
});

describe("点通知进运营台：跳转只认 /admin 下面", () => {
  it("运营去处", async () => {
    const { 运营去处 } = await import("@/lib/ops-auth");
    expect(运营去处("/admin/users/abc")).toBe("/admin/users/abc");
    expect(运营去处("/admin")).toBe("/admin");
    expect(运营去处("//evil.com")).toBeNull();
    expect(运营去处("/admin/../customers")).toBeNull();
    expect(运营去处("https://evil.com/admin")).toBeNull();
    expect(运营去处("/admin?x=1")).toBeNull();
  });
  it("进门码带着 next，进门后跳到那一页", async () => {
    const boss = (await (await import("@/lib/tenant/control")).control.account.findFirst({ where: { email: "boss@example.com" } })) ?? (await 建账号("boss@example.com"));
    const t = await 发令牌(boss.id);
    const { POST } = await import("@/app/api/ops/enter/route");
    const r = await POST(new Request("https://app.example.com/api/ops/enter?next=%2Fadmin%2Ffeedback", { method: "POST", headers: { Authorization: `Bearer ${t}` } }));
    const { path: 路径 } = (await r.json()) as { path: string };
    expect(路径).toMatch(/&next=%2Fadmin%2Ffeedback$/);
    const { GET: 进门 } = await import("@/app/admin/enter/route");
    const res = await 进门(new Request(`https://app.example.com${路径}`));
    expect(res.headers.get("Location")).toBe("/admin/feedback");
    // 坏的 next：照样进门，落在 /admin
    const r2 = await POST(new Request("https://app.example.com/api/ops/enter?next=%2F%2Fevil.com", { method: "POST", headers: { Authorization: `Bearer ${t}` } }));
    const p2 = ((await r2.json()) as { path: string }).path;
    expect(p2).not.toContain("next=");
  });
});
