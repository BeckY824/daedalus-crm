import { closeTestDatabases } from "./close-databases";
/**
 * 运营台回复反馈（lib/feedback-reply.ts + admin/actions.ts 的 回复反馈，2026-10-02）。
 *
 * 钉的是：信里带原话、Reply-To 一定有（发件地址收不了信）；收件人和正文先校验；
 * 没口令调不动；**发出去了才留底、才算处理过了**——发失败什么都不记；
 * 存量库的迁移补得上这张表。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { 回复邮件 } from "@/lib/feedback-reply";

const 根 = path.resolve(__dirname, "..");
const 临时根 = path.join(os.tmpdir(), `crm-feedback-reply-${process.pid}`);
const TOKEN = "test-admin-token-feedback-reply";

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

beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.feedbackReply.deleteMany({});
  await control.feedback.deleteMany({});
  发出 = [];
  const { 设置回复发送器 } = await import("@/lib/feedback-reply");
  设置回复发送器(async (m) => {
    发出.push(m);
  });
});

async function 建反馈(body = "导入的时候卡住了\n第二行") {
  const { control } = await import("@/lib/tenant/control");
  return control.feedback.create({ data: { body, source: "desktop", who: "张三 · a@b.com", at: new Date("2026-10-01T06:30:00Z") } });
}

describe("组信", () => {
  it("带原话（逐行引用）、写北京时间、Reply-To 有值", async () => {
    const { 组回复邮件 } = await import("@/lib/feedback-reply");
    const m = 组回复邮件(
      { to: "a@b.com", body: " 已经修好了 ", 原话: "第一行\n第二行", 原话时间: new Date("2026-10-01T06:30:00Z"), replyTo: "ops@x.com" },
      {},
    );
    expect(m.to).toBe("a@b.com");
    expect(m.replyTo).toBe("ops@x.com");
    expect(m.subject).toBe("回复你的 Daedalus CRM 反馈");
    expect(m.text.startsWith("已经修好了\n")).toBe(true);
    expect(m.text).toContain("你 10-01 14:30 的反馈：\n> 第一行\n> 第二行");
  });

  it("回信地址：FEEDBACK_REPLY_TO > 运营本人 > 收线索的邮箱", async () => {
    const { 回信地址 } = await import("@/lib/feedback-reply");
    expect(回信地址("ops@x.com", { FEEDBACK_REPLY_TO: "fb@x.com" })).toBe("fb@x.com");
    expect(回信地址("ops@x.com", {})).toBe("ops@x.com");
    expect(回信地址(null, { LEAD_TO: "lead@x.com" })).toBe("lead@x.com");
  });

  it("收件人和正文先校验", async () => {
    const { 查回复 } = await import("@/lib/feedback-reply");
    expect(查回复("", "hi").ok).toBe(false);
    expect(查回复("不是邮箱", "hi").ok).toBe(false);
    expect(查回复("a@b.com", "  ").ok).toBe(false);
    expect(查回复("a@b.com", "x".repeat(4001)).ok).toBe(false);
    expect(查回复(" a@b.com ", " hi ")).toEqual({ ok: true, to: "a@b.com", body: "hi" });
  });
});

describe("回复反馈（运营台动作）", () => {
  it("没口令调不动，也不发信", async () => {
    const { 回复反馈 } = await import("@/app/admin/actions");
    const f = await 建反馈();
    const r = await 回复反馈({ token: "", id: f.id, to: "a@b.com", body: "hi" });
    expect(r.ok).toBe(false);
    expect(发出).toHaveLength(0);
  });

  it("发出去了：留底、标成处理过了、读反馈带得出来", async () => {
    const { 回复反馈 } = await import("@/app/admin/actions");
    const { 读反馈 } = await import("@/app/admin/data");
    const f = await 建反馈();
    const r = await 回复反馈({ token: TOKEN, id: f.id, to: "a@b.com", body: "已经修好了" });
    expect(r).toEqual({ ok: true });
    expect(发出).toHaveLength(1);
    expect(发出[0].text).toContain("> 导入的时候卡住了");
    expect(发出[0].replyTo).toBeTruthy();

    const 条 = (await 读反馈()).find((x) => x.id === f.id)!;
    expect(条.handled).toBe(true);
    expect(条.回复).toHaveLength(1);
    expect(条.回复[0]).toMatchObject({ to: "a@b.com", body: "已经修好了", by: "口令" });
  });

  it("发失败：报错，什么都不记，也不标处理过了", async () => {
    const { 回复反馈 } = await import("@/app/admin/actions");
    const { 设置回复发送器 } = await import("@/lib/feedback-reply");
    const { control } = await import("@/lib/tenant/control");
    设置回复发送器(async () => {
      throw new Error("535 Authentication failure");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await 建反馈();
    const r = await 回复反馈({ token: TOKEN, id: f.id, to: "a@b.com", body: "hi" });
    expect(r.ok).toBe(false);
    expect(await control.feedbackReply.count()).toBe(0);
    expect((await control.feedback.findUnique({ where: { id: f.id } }))!.handled).toBe(false);
  });

  it("桌面端账号的反馈默认带出他的注册邮箱", async () => {
    const { control } = await import("@/lib/tenant/control");
    const { createAccount } = await import("@/lib/tenant/accounts");
    const { 读反馈 } = await import("@/app/admin/data");
    const a = await createAccount({ target: { kind: "email", value: `fb${Date.now()}@b.com` }, password: "abcd1234", name: "李四" });
    const f = await control.feedback.create({ data: { body: "x", source: "desktop", accountId: a.id } });
    const 条 = (await 读反馈()).find((x) => x.id === f.id)!;
    expect(条.邮箱).toBe(a.email);
  });
});

describe("存量库", () => {
  it("control.prisma 和 control-migrations/ 都有 FeedbackReply", () => {
    expect(fs.readFileSync(path.join(根, "prisma/control.prisma"), "utf8")).toContain("model FeedbackReply");
    const sql = fs.readFileSync(path.join(根, "control-migrations/015-feedback-reply.sql"), "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "FeedbackReply"');
  });
});
