/**
 * 托管版的成员：管理员在「设置管理 → 用户管理」里加的人，**必须真的能登录**。
 *
 * 在这之前不能。那边登录校验的是控制面的 `Account`，而加成员只在业务库里建了
 * 一条 `User`——那个人有身份、有归属、能被选成负责人，就是进不来。
 * 也就是说一个托管版工作区实际上只有开号的那一个人用得了，
 * 而托管版正是拿来给别的公司试用的通道。
 *
 * 顺带钉住同一处的另一件事：托管版里改自己的密码要改控制面那把。
 * 业务库那一列存的是 `!managed`，拿它去 bcrypt.compare 永远不成立——
 * 之前托管版里没有人改得了自己的密码，界面一律回「原密码错误」。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-member-${process.pid}`);
const 模板 = path.join(临时根, "_template.db");

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  execFileSync("node", ["--experimental-sqlite", "scripts/build-template.mjs", 模板], { stdio: "pipe" });
  process.env.MULTI_TENANT = "1";
  process.env.WORKSPACE_DIR = 临时根;
  process.env.WORKSPACE_TEMPLATE = 模板;
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync(
    "npx",
    ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
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

afterAll(() => {
  delete process.env.MULTI_TENANT;
  fs.rmSync(临时根, { recursive: true, force: true });
});

let n = 0;
/** 开一个工作区，返回它和它的 OWNER */
async function 开工作区() {
  const { createAccount } = await import("@/lib/tenant/accounts");
  const { createWorkspace } = await import("@/lib/tenant/workspaces");
  const i = n++;
  const acc = await createAccount({
    target: { kind: "email", value: `owner${i}@example.com` },
    password: "abcd1234",
    name: `老板${i}`,
  });
  const ws = await createWorkspace({ name: `团队${i}`, account: acc });
  return { acc, ws };
}

describe("给成员配一个能登录的账号", () => {
  it("配完之后：控制面有账号、有成员资格，密码也对", async () => {
    const { 配账号 } = await import("@/lib/tenant/members");
    const { verifyAccount } = await import("@/lib/tenant/accounts");
    const { listWorkspacesFor } = await import("@/lib/tenant/workspaces");
    const { ws } = await 开工作区();

    const r = await 配账号({
      workspaceId: ws.id,
      userId: "u-1",
      email: "LiSi@Qiming.com",
      password: "lisi12345",
      name: "李四",
      role: "SALES",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 登录那两步：账号密码对得上，而且他属于这个工作区
    const 登录 = await verifyAccount("lisi@qiming.com", "lisi12345");
    expect(登录, "加进来的成员应当能通过登录校验").not.toBeNull();
    const 工作区们 = await listWorkspacesFor(r.accountId);
    expect(工作区们.map((w) => w.id)).toEqual([ws.id]);
  });

  it("邮箱已经有账号的，直接拒——不顺手绑进别人的工作区", async () => {
    /**
     * 绑上去意味着任何一个工作区的管理员，只要知道你的邮箱就能把你拉进他的工作区，
     * 而登录默认进第一个工作区——那等于能改变别人登录后看到的东西。
     */
    const { 配账号 } = await import("@/lib/tenant/members");
    const { ws } = await 开工作区();
    const 甲 = await 配账号({ workspaceId: ws.id, userId: "u-2", email: "dup@example.com", password: "abcd1234", name: "甲", role: "SALES" });
    expect(甲.ok).toBe(true);

    const { ws: 别家 } = await 开工作区();
    const 乙 = await 配账号({ workspaceId: 别家.id, userId: "u-3", email: "dup@example.com", password: "abcd1234", name: "乙", role: "SALES" });
    expect(乙.ok).toBe(false);
    if (!乙.ok) expect(乙.error).toContain("已经注册过");
  });

  it("弱密码和非邮箱都拒，且什么都不留下", async () => {
    const { 配账号 } = await import("@/lib/tenant/members");
    const { control } = await import("@/lib/tenant/control");
    const { ws } = await 开工作区();
    const 前 = await control.account.count();
    expect((await 配账号({ workspaceId: ws.id, userId: "u", email: "lisi", password: "abcd1234", name: "x", role: "SALES" })).ok).toBe(false);
    expect((await 配账号({ workspaceId: ws.id, userId: "u", email: "a@b.com", password: "abc", name: "x", role: "SALES" })).ok).toBe(false);
    expect(await control.account.count()).toBe(前);
  });
});

describe("停用与恢复", () => {
  it("撤掉成员资格之后就不属于这个工作区了，恢复之后又属于", async () => {
    const { 配账号, 撤成员, 复成员 } = await import("@/lib/tenant/members");
    const { listWorkspacesFor } = await import("@/lib/tenant/workspaces");
    const { ws } = await 开工作区();
    const r = await 配账号({ workspaceId: ws.id, userId: "u-4", email: "off@example.com", password: "abcd1234", name: "丙", role: "SALES" });
    if (!r.ok) throw new Error(r.error);

    await 撤成员(r.accountId, ws.id);
    expect(await listWorkspacesFor(r.accountId)).toEqual([]);
    await 复成员(r.accountId, ws.id, "SALES");
    expect((await listWorkspacesFor(r.accountId)).map((w) => w.id)).toEqual([ws.id]);
    // 恢复是幂等的：连点两次不该撞唯一索引
    await 复成员(r.accountId, ws.id, "SALES");
    expect((await listWorkspacesFor(r.accountId)).length).toBe(1);
  });
});

describe("改密码改的是控制面那把", () => {
  it("核对与更新都作用在 Account 上，改完旧会话作废", async () => {
    const { 配账号, 核对密码, 改密码 } = await import("@/lib/tenant/members");
    const { verifyAccount } = await import("@/lib/tenant/accounts");
    const { 会话已作废 } = await import("@/lib/tenant/session-cutoff");
    const { ws } = await 开工作区();
    const r = await 配账号({ workspaceId: ws.id, userId: "u-5", email: "pw@example.com", password: "old12345", name: "丁", role: "SALES" });
    if (!r.ok) throw new Error(r.error);

    expect(await 核对密码(r.accountId, "old12345")).toBe(true);
    expect(await 核对密码(r.accountId, "错的")).toBe(false);

    const 此刻 = Math.floor(Date.now() / 1000);
    expect((await 改密码(r.accountId, "new12345")).ok).toBe(true);
    expect(await verifyAccount("pw@example.com", "new12345")).not.toBeNull();
    expect(await verifyAccount("pw@example.com", "old12345")).toBeNull();
    // 改密之前签的票不认了
    expect(await 会话已作废(r.accountId, 此刻 - 60)).toBe(true);
  });

  it("弱密码拒掉，原密码不动", async () => {
    const { 配账号, 改密码 } = await import("@/lib/tenant/members");
    const { verifyAccount } = await import("@/lib/tenant/accounts");
    const { ws } = await 开工作区();
    const r = await 配账号({ workspaceId: ws.id, userId: "u-6", email: "weak@example.com", password: "old12345", name: "戊", role: "SALES" });
    if (!r.ok) throw new Error(r.error);
    expect((await 改密码(r.accountId, "abc")).ok).toBe(false);
    expect(await verifyAccount("weak@example.com", "old12345")).not.toBeNull();
  });
});
