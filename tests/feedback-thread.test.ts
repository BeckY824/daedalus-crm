import { closeTestDatabases } from "./close-databases";
/**
 * 反馈的一整串往来（2026-10-19）：运营台回复进应用，用户在桌面端「接着说」。
 *
 * 钉的是：
 *   - 云端「我的反馈」只回令牌对应的那个账号的，令牌不对 401
 *   - 接着说挂在对的那一串下面；别人的反馈一律 404、一行都不落；同一个 clientKey 重发不落两行；接着说把那条顶回「没处理」
 *   - 运营台回复默认进应用；勾了邮件、邮件没发出去，应用里那份照样在，如实回「没发出去」；手机号账号勾了也不发
 *   - 0.46.22 之前只走邮件的回复（FeedbackReply）并进同一串
 *   - 运营通知里有「接着说」
 *   - 未读、排序、截字的纯规则；迁移文件在
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { 回复邮件 } from "@/lib/feedback-reply";

const 根 = path.resolve(__dirname, "..");
const 临时根 = path.join(os.tmpdir(), `crm-feedback-thread-${process.pid}`);
const TOKEN = "test-admin-token-feedback-thread";

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.ADMIN_TOKEN = TOKEN;
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
  delete process.env.ADMIN_TOKEN;
  const { 设置回复发送器 } = await import("@/lib/feedback-reply");
  设置回复发送器(null);
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

let 发出: 回复邮件[] = [];
let 序 = 0;

beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.feedbackMessage.deleteMany({});
  await control.feedbackReply.deleteMany({});
  await control.feedback.deleteMany({});
  发出 = [];
  const { 设置回复发送器 } = await import("@/lib/feedback-reply");
  设置回复发送器(async (m) => {
    发出.push(m);
  });
});

/** 一个桌面端账号 + 一枚设备令牌 */
async function 建人(kind: "email" | "phone" = "email") {
  const { createAccount } = await import("@/lib/tenant/accounts");
  const { 签发 } = await import("@/lib/tenant/device-token");
  序++;
  const value = kind === "email" ? `t${Date.now()}${序}@b.com` : `1381111${String(1000 + 序).slice(-4)}`;
  const a = await createAccount({ target: { kind, value }, password: "abcd1234", name: `人${序}` });
  const { token } = await 签发(a.id, "测试机");
  return { id: a.id, email: a.email, token };
}

async function 发反馈(accountId: string, body = "导入的时候卡住了", at = new Date()) {
  const { control } = await import("@/lib/tenant/control");
  return control.feedback.create({ data: { body, source: "desktop", accountId, who: "某人", at } });
}

const 请求 = (method: "GET" | "POST", token: string | null, body?: unknown) =>
  new Request("http://cloud.test/api/feedback/mine", {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("云端：我的反馈", () => {
  it("只回令牌对应的那个账号的，别人的一条都不回", async () => {
    const { GET } = await import("@/app/api/feedback/mine/route");
    const 甲 = await 建人();
    const 乙 = await 建人();
    const f甲 = await 发反馈(甲.id, "甲的反馈");
    await 发反馈(乙.id, "乙的反馈");
    const r = await GET(请求("GET", 甲.token));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { 反馈: { id: string; body: string }[] };
    expect(j.反馈.map((f) => f.body)).toEqual(["甲的反馈"]);
    expect(j.反馈[0].id).toBe(f甲.id);
  });

  it("令牌不对 401；被吊销的也 401", async () => {
    const { GET, POST } = await import("@/app/api/feedback/mine/route");
    const { control } = await import("@/lib/tenant/control");
    const { 指纹 } = await import("@/lib/tenant/device-token");
    expect((await GET(请求("GET", "dk_not-a-real-token"))).status).toBe(401);
    expect((await POST(请求("POST", "dk_not-a-real-token", { feedbackId: "x", body: "hi" }))).status).toBe(401);
    const 甲 = await 建人();
    await control.deviceToken.update({ where: { tokenHash: 指纹(甲.token) }, data: { revokedAt: new Date() } });
    expect((await GET(请求("GET", 甲.token))).status).toBe(401);
  });

  it("给用户的那份不带运营是谁、邮件发到哪", async () => {
    const { GET } = await import("@/app/api/feedback/mine/route");
    const { 回复反馈 } = await import("@/app/admin/actions");
    const 甲 = await 建人();
    const f = await 发反馈(甲.id);
    await 回复反馈({ token: TOKEN, id: f.id, body: "修好了", 发邮件: true });
    const j = (await (await GET(请求("GET", 甲.token))).json()) as { 反馈: { 消息: Record<string, unknown>[] }[] };
    expect(j.反馈[0].消息).toHaveLength(1);
    expect(Object.keys(j.反馈[0].消息[0]).sort()).toEqual(["at", "body", "id", "谁"]);
    expect(j.反馈[0].消息[0]).toMatchObject({ 谁: "团队", body: "修好了" });
  });
});

describe("云端：接着说", () => {
  it("挂在对的那一串下面，那条重新算没处理", async () => {
    const { POST, GET } = await import("@/app/api/feedback/mine/route");
    const { control } = await import("@/lib/tenant/control");
    const 甲 = await 建人();
    const 一 = await 发反馈(甲.id, "第一条", new Date("2026-10-18T01:00:00Z"));
    const 二 = await 发反馈(甲.id, "第二条", new Date("2026-10-19T01:00:00Z"));
    await control.feedback.update({ where: { id: 一.id }, data: { handled: true } });
    const r = await POST(请求("POST", 甲.token, { feedbackId: 一.id, body: "  还是不行\n截图在这  ", clientKey: "c_1" }));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { 消息: { 谁: string; body: string } };
    expect(j.消息).toMatchObject({ 谁: "我", body: "还是不行\n截图在这" });

    const 行 = await control.feedbackMessage.findMany();
    expect(行).toHaveLength(1);
    expect(行[0]).toMatchObject({ feedbackId: 一.id, side: "user", clientKey: "c_1" });
    expect((await control.feedback.findUnique({ where: { id: 一.id } }))!.handled).toBe(false);

    const 我的 = (await (await GET(请求("GET", 甲.token))).json()) as { 反馈: { id: string; 消息: unknown[] }[] };
    expect(我的.反馈.find((f) => f.id === 一.id)!.消息).toHaveLength(1);
    expect(我的.反馈.find((f) => f.id === 二.id)!.消息).toHaveLength(0);
  });

  it("别人的反馈：404，一行都不落，那条也不被顶回没处理", async () => {
    const { POST } = await import("@/app/api/feedback/mine/route");
    const { control } = await import("@/lib/tenant/control");
    const 甲 = await 建人();
    const 乙 = await 建人();
    const f乙 = await 发反馈(乙.id);
    await control.feedback.update({ where: { id: f乙.id }, data: { handled: true } });
    const r = await POST(请求("POST", 甲.token, { feedbackId: f乙.id, body: "插一句" }));
    expect(r.status).toBe(404);
    expect(await control.feedbackMessage.count()).toBe(0);
    expect((await control.feedback.findUnique({ where: { id: f乙.id } }))!.handled).toBe(true);
    // 不存在的 id 也是同一个 404：不给人拿 id 去试哪条存在
    const r2 = await POST(请求("POST", 甲.token, { feedbackId: "nope", body: "插一句" }));
    expect(r2.status).toBe(404);
    expect(await r2.json()).toEqual(await r.json());
  });

  it("同一个 clientKey 重发：回上次那条，不落第二行", async () => {
    const { POST } = await import("@/app/api/feedback/mine/route");
    const { control } = await import("@/lib/tenant/control");
    const 甲 = await 建人();
    const f = await 发反馈(甲.id);
    const a = (await (await POST(请求("POST", 甲.token, { feedbackId: f.id, body: "补一句", clientKey: "k1" }))).json()) as { 消息: { id: string } };
    const b = (await (await POST(请求("POST", 甲.token, { feedbackId: f.id, body: "补一句", clientKey: "k1" }))).json()) as { 消息: { id: string } };
    expect(b.消息.id).toBe(a.消息.id);
    expect(await control.feedbackMessage.count()).toBe(1);
  });

  it("空的、太长的不收", async () => {
    const { POST } = await import("@/app/api/feedback/mine/route");
    const 甲 = await 建人();
    const f = await 发反馈(甲.id);
    expect((await POST(请求("POST", 甲.token, { feedbackId: f.id, body: "   " }))).status).toBe(400);
    expect((await POST(请求("POST", 甲.token, { feedbackId: f.id, body: "x".repeat(4001) }))).status).toBe(400);
  });
});

describe("运营台回复：默认进应用，邮件可选", () => {
  it("不勾邮件：只进应用，不发信，标处理过了", async () => {
    const { 回复反馈 } = await import("@/app/admin/actions");
    const { 读反馈 } = await import("@/app/admin/data");
    const 甲 = await 建人();
    const f = await 发反馈(甲.id);
    const r = await 回复反馈({ token: TOKEN, id: f.id, body: "看到了，下一版修" });
    expect(r).toEqual({ ok: true, 邮件: "没要发", 邮件到: null });
    expect(发出).toHaveLength(0);
    const 条 = (await 读反馈()).find((x) => x.id === f.id)!;
    expect(条.handled).toBe(true);
    expect(条.串).toEqual([expect.objectContaining({ 谁: "团队", body: "看到了，下一版修", 邮件: null })]);
  });

  it("勾了邮件：发到账号邮箱，信里带原话", async () => {
    const { 回复反馈 } = await import("@/app/admin/actions");
    const 甲 = await 建人();
    const f = await 发反馈(甲.id, "原话在这");
    const r = await 回复反馈({ token: TOKEN, id: f.id, body: "修好了", 发邮件: true, to: "别人@x.com" });
    expect(r).toEqual({ ok: true, 邮件: "发了", 邮件到: 甲.email });
    expect(发出).toHaveLength(1);
    // 发到账号自己的邮箱，不信页面传来的
    expect(发出[0].to).toBe(甲.email);
    expect(发出[0].text).toContain("> 原话在这");
  });

  it("勾了邮件、邮件没发出去：应用里那份照样在，如实回没发出去", async () => {
    const { 回复反馈 } = await import("@/app/admin/actions");
    const { 读反馈 } = await import("@/app/admin/data");
    const { 设置回复发送器 } = await import("@/lib/feedback-reply");
    设置回复发送器(async () => {
      throw new Error("535 Authentication failure");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const 甲 = await 建人();
    const f = await 发反馈(甲.id);
    const r = await 回复反馈({ token: TOKEN, id: f.id, body: "修好了", 发邮件: true });
    expect(r).toMatchObject({ ok: true, 邮件: "没发出去", 邮件到: 甲.email });
    const 条 = (await 读反馈()).find((x) => x.id === f.id)!;
    expect(条.串[0]).toMatchObject({ 谁: "团队", body: "修好了", 邮件: { to: 甲.email, ok: false } });
  });

  it("手机号注册的账号：勾了邮件也不发，回原因；应用里照样有", async () => {
    const { 回复反馈 } = await import("@/app/admin/actions");
    const { 读反馈 } = await import("@/app/admin/data");
    const 甲 = await 建人("phone");
    const f = await 发反馈(甲.id);
    const r = await 回复反馈({ token: TOKEN, id: f.id, body: "收到", 发邮件: true });
    expect(r).toMatchObject({ ok: true, 邮件: "没发出去", 邮件到: null, 原因: "这个账号没留邮箱" });
    expect(发出).toHaveLength(0);
    const 条 = (await 读反馈()).find((x) => x.id === f.id)!;
    expect(条.邮箱).toBeNull();
    expect(条.串).toHaveLength(1);
  });

  it("没口令调不动", async () => {
    const { 回复反馈 } = await import("@/app/admin/actions");
    const { control } = await import("@/lib/tenant/control");
    const 甲 = await 建人();
    const f = await 发反馈(甲.id);
    expect((await 回复反馈({ token: "", id: f.id, body: "hi" })).ok).toBe(false);
    expect(await control.feedbackMessage.count()).toBe(0);
  });

  it("一整串：老邮件回复、新回复、接着说按时间排；运营台看得到谁接着说了", async () => {
    const { control } = await import("@/lib/tenant/control");
    const { 读反馈 } = await import("@/app/admin/data");
    const { 我的反馈 } = await import("@/lib/feedback-thread");
    const 甲 = await 建人();
    const f = await 发反馈(甲.id, "原话", new Date("2026-10-10T00:00:00Z"));
    await control.feedbackReply.create({ data: { feedbackId: f.id, to: 甲.email!, body: "老邮件", at: new Date("2026-10-11T00:00:00Z") } });
    await control.feedbackMessage.create({ data: { feedbackId: f.id, side: "user", body: "接着说", at: new Date("2026-10-12T00:00:00Z") } });
    await control.feedbackMessage.create({ data: { feedbackId: f.id, side: "team", body: "新回复", at: new Date("2026-10-13T00:00:00Z") } });
    const 条 = (await 读反馈()).find((x) => x.id === f.id)!;
    expect(条.串.map((m) => `${m.谁}:${m.body}`)).toEqual(["团队:老邮件", "我:接着说", "团队:新回复"]);
    expect(条.串[0].邮件).toEqual({ to: 甲.email, ok: true });
    const 我 = await 我的反馈(甲.id);
    expect(我[0].消息.map((m) => m.body)).toEqual(["老邮件", "接着说", "新回复"]);
  });
});

describe("运营通知：接着说也报", () => {
  it("since 之后的接着说出一条，带上是谁", async () => {
    const { 读运营通知 } = await import("@/lib/ops-notices");
    const { control } = await import("@/lib/tenant/control");
    const 甲 = await 建人();
    const f = await control.feedback.create({ data: { body: "原话", source: "desktop", accountId: 甲.id, who: "张三 · a@b.com", at: new Date("2026-10-01T00:00:00Z") } });
    const now = new Date();
    await control.feedbackMessage.create({ data: { feedbackId: f.id, side: "user", body: "还是不行\n第二行", at: new Date(now.getTime() - 60_000) } });
    await control.feedbackMessage.create({ data: { feedbackId: f.id, side: "team", body: "我们回的不报", at: new Date(now.getTime() - 30_000) } });
    const r = await 读运营通知(new Date(now.getTime() - 5 * 60_000).toISOString(), now, {});
    const 这条 = r.事件.filter((e) => e.key.startsWith("接着说:"));
    expect(这条).toHaveLength(1);
    expect(这条[0]).toMatchObject({ kind: "反馈", 标题: "接着说：张三 · a@b.com", path: "/admin/feedback" });
    expect(这条[0].正文).toContain("还是不行");
  });
});

describe("纯规则", () => {
  const 回 = (id: string, at: string) => ({ id, at, 谁: "团队" as const, body: `回复${id}` });
  const 我 = (id: string, at: string) => ({ id, at, 谁: "我" as const, body: "我说" });

  it("未读：我们最后回的那条不是本机看过的那条；最后一句是自己的不算", async () => {
    const { 算未读 } = await import("@/lib/feedback-unread");
    const f = { id: "f", at: "2026-10-01", body: "x", 消息: [回("a", "2026-10-02"), 回("b", "2026-10-03")] };
    expect(算未读({ ...f, 消息: [] }, {})).toBe(false);
    expect(算未读(f, {})).toBe(true);
    expect(算未读(f, { f: "a" })).toBe(true);
    expect(算未读(f, { f: "b" })).toBe(false);
    expect(算未读({ ...f, 消息: [...f.消息, 我("c", "2026-10-04")] }, {})).toBe(false);
  });

  it("列表按最近一次往来排：老反馈刚回了一句就顶上来", async () => {
    const { 排好 } = await import("@/lib/feedback-unread");
    const 老 = { id: "old", at: "2026-10-01T00:00:00Z", body: "老", 消息: [回("r", "2026-10-19T00:00:00Z")], 未读: true };
    const 新 = { id: "new", at: "2026-10-10T00:00:00Z", body: "新", 消息: [], 未读: false };
    expect(排好([新, 老]).map((f) => f.id)).toEqual(["old", "new"]);
  });

  it("截字压成一行、按码点截，emoji 不切半个", async () => {
    const { 一句, 第一行 } = await import("@/lib/feedback-unread");
    expect(一句("第一行\n\n  第二行", 40)).toBe("第一行 第二行");
    expect(一句("😀".repeat(50), 5)).toBe("😀😀😀😀…");
    expect(第一行("\n\n  标题行 \n正文")).toBe("标题行");
  });

  it("云端回来的坏数据丢掉，不让页面出错", async () => {
    const { 规整反馈 } = await import("@/lib/feedback-unread");
    expect(规整反馈(null)).toEqual([]);
    expect(规整反馈([{ id: 1 }, { id: "a", at: "t", body: "b", 消息: [{ id: "m", at: "t", 谁: "黑客", body: "x" }, 回("ok", "t")] }])).toEqual([
      { id: "a", at: "t", body: "b", 消息: [回("ok", "t")] },
    ]);
  });
});

describe("存量库", () => {
  it("control.prisma 和 control-migrations/ 都有 FeedbackMessage", () => {
    expect(fs.readFileSync(path.join(根, "prisma/control.prisma"), "utf8")).toContain("model FeedbackMessage");
    const sql = fs.readFileSync(path.join(根, "control-migrations/027-feedback-message.sql"), "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "FeedbackMessage"');
  });
});
