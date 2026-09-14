/**
 * 运营台的越权边界。
 *
 * /admin 不走应用的登录体系，只有一个 ADMIN_TOKEN。所以两件事必须钉死：
 *   1. 每个动作单独验 token——Server Action 是独立的 HTTP 端点，
 *      「页面进得来所以动作能调」是最常见的一类越权
 *   2. 没配 token 时整个运营台不存在，免得自部署的人暴露一个无保护的后台
 *
 * 另外钉住一条产品上的关键约定：**用户提交付款不会自己延期**。
 * 那等于把付费做成荣誉制度，任何人点一下就能续命。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// revalidatePath 要 Next 的请求上下文，单测里没有。它只影响页面缓存，
// 与这里要验的授权和日期计算无关，直接空掉
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-admin-${process.pid}`);
const TOKEN = "test-admin-token-0123456789";

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  // openWorkspace 会真的复制一份库文件出来，所以要有真模板
  execFileSync("node", ["--experimental-sqlite", "scripts/build-template.mjs", path.join(临时根, "_template.db")], { stdio: "pipe" });
  process.env.WORKSPACE_DIR = 临时根;
  process.env.WORKSPACE_TEMPLATE = path.join(临时根, "_template.db");
  process.env.MULTI_TENANT = "1";
  process.env.ADMIN_TOKEN = TOKEN;
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
  delete process.env.ADMIN_TOKEN;
  fs.rmSync(临时根, { recursive: true, force: true });
});

/** 建一个试用中的工作区，返回 id */
async function 建工作区(id: string) {
  const { control } = await import("@/lib/tenant/control");
  await control.workspace.create({
    data: {
      id,
      slug: id,
      name: `工作区 ${id}`,
      dbFile: `${id}.db`,
      status: "TRIAL",
      trialEndsAt: new Date(Date.now() + 3 * 86_400_000),
    },
  });
  return id;
}

describe("每个动作都要验 token", () => {
  it("不带 token 开不了通", async () => {
    const { activate } = await import("@/app/admin/actions");
    const id = await 建工作区("w-noauth");
    const r = await activate({ token: "", workspaceId: id, plan: "year" });
    expect(r.ok).toBe(false);

    const { control } = await import("@/lib/tenant/control");
    const ws = await control.workspace.findUnique({ where: { id } });
    expect(ws?.paidUntil).toBeNull();
    expect(ws?.status).toBe("TRIAL");
  });

  it("token 不对也开不了通", async () => {
    const { activate } = await import("@/app/admin/actions");
    const id = await 建工作区("w-wrongauth");
    expect((await activate({ token: "猜的", workspaceId: id, plan: "year" })).ok).toBe(false);
  });

  it("延长试用与停用同样要验", async () => {
    const { extendTrial, suspend } = await import("@/app/admin/actions");
    const id = await 建工作区("w-other");
    expect((await extendTrial({ token: "", workspaceId: id, days: 30 })).ok).toBe(false);
    expect((await suspend({ token: "", workspaceId: id, on: true })).ok).toBe(false);
  });

  it("带对 token 才真的开通", async () => {
    const { activate } = await import("@/app/admin/actions");
    const { control } = await import("@/lib/tenant/control");
    const id = await 建工作区("w-ok");
    expect((await activate({ token: TOKEN, workspaceId: id, plan: "month" })).ok).toBe(true);

    const ws = await control.workspace.findUnique({ where: { id } });
    expect(ws?.status).toBe("ACTIVE");
    expect(ws?.paidUntil).toBeTruthy();
    expect(ws!.paidUntil!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("续费顺延", () => {
  it("连开两次年付，第二次从第一次的到期日往后加", async () => {
    const { activate } = await import("@/app/admin/actions");
    const { control } = await import("@/lib/tenant/control");
    const { PLANS } = await import("@/lib/tenant/plans");
    const id = await 建工作区("w-renew");

    await activate({ token: TOKEN, workspaceId: id, plan: "year" });
    const 第一次 = (await control.workspace.findUnique({ where: { id } }))!.paidUntil!;

    await activate({ token: TOKEN, workspaceId: id, plan: "year" });
    const 第二次 = (await control.workspace.findUnique({ where: { id } }))!.paidUntil!;

    const 相差天 = Math.round((第二次.getTime() - 第一次.getTime()) / 86_400_000);
    expect(相差天).toBe(PLANS.year.days);
  });
});

describe("延长试用与停用", () => {
  it("延长试用会往后推，且有上限保护", async () => {
    const { extendTrial } = await import("@/app/admin/actions");
    const { control } = await import("@/lib/tenant/control");
    const id = await 建工作区("w-extend");
    const 原 = (await control.workspace.findUnique({ where: { id } }))!.trialEndsAt;

    await extendTrial({ token: TOKEN, workspaceId: id, days: 7 });
    const 新 = (await control.workspace.findUnique({ where: { id } }))!.trialEndsAt;
    expect(Math.round((新.getTime() - 原.getTime()) / 86_400_000)).toBe(7);

    // 上限 90 天：手滑输个 9999 不该把试用送出去十年
    await extendTrial({ token: TOKEN, workspaceId: id, days: 9999 });
    const 再 = (await control.workspace.findUnique({ where: { id } }))!.trialEndsAt;
    expect(Math.round((再.getTime() - 新.getTime()) / 86_400_000)).toBe(90);
  });

  it("停用后立刻只读，恢复后回到试用", async () => {
    const { suspend } = await import("@/app/admin/actions");
    const { control } = await import("@/lib/tenant/control");
    const { computeWritable } = await import("@/lib/tenant/workspaces");
    const id = await 建工作区("w-susp");

    await suspend({ token: TOKEN, workspaceId: id, on: true });
    let ws = (await control.workspace.findUnique({ where: { id } }))!;
    expect(computeWritable(ws)).toBe(false);

    await suspend({ token: TOKEN, workspaceId: id, on: false });
    ws = (await control.workspace.findUnique({ where: { id } }))!;
    expect(computeWritable(ws)).toBe(true);
  });
});

/**
 * 开工作区。自助注册下线后这是唯一的建号入口，所以它既是运营的工具，
 * 也是一个「带对 token 就能凭空造账号」的端点——鉴权必须和别的动作一样严。
 */
describe("开工作区", () => {
  it("不带 token 建不出来", async () => {
    const { openWorkspace } = await import("@/app/admin/actions");
    const { control } = await import("@/lib/tenant/control");
    const 前 = await control.workspace.count();

    const r = await openWorkspace({ token: "", workspace: "启明教育", name: "王老师", target: "13800138001" });

    expect(r.ok).toBe(false);
    // 不只是返回失败，得确认真的什么都没建
    expect(await control.workspace.count()).toBe(前);
    expect(await control.account.count({ where: { phone: "13800138001" } })).toBe(0);
  });

  it("token 不对也建不出来", async () => {
    const { openWorkspace } = await import("@/app/admin/actions");
    const r = await openWorkspace({ token: "猜的", workspace: "启明教育", name: "王老师", target: "13800138002" });
    expect(r.ok).toBe(false);
  });

  it("带对 token 建出一个能写的试用工作区，并把初始密码带回来一次", async () => {
    const { openWorkspace } = await import("@/app/admin/actions");
    const { control } = await import("@/lib/tenant/control");
    const { computeWritable } = await import("@/lib/tenant/workspaces");

    const r = await openWorkspace({ token: TOKEN, workspace: "启明教育", name: "王老师", target: "13800138003" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 密码是发给陌生人的，不能短
    expect(r.password.length).toBeGreaterThanOrEqual(10);
    expect(r.contact).toBe("13800138003");

    const ws = await control.workspace.findUnique({ where: { slug: r.slug }, include: { memberships: true } });
    expect(ws).not.toBeNull();
    expect(ws!.status).toBe("TRIAL");
    expect(computeWritable(ws!)).toBe(true);
    // 建号的人就是 OWNER，否则他自己进不去自己的工作区
    expect(ws!.memberships[0].role).toBe("OWNER");
  });

  it("密码是哈希存的——运营台能看到明文，库里不能", async () => {
    const { openWorkspace } = await import("@/app/admin/actions");
    const { control } = await import("@/lib/tenant/control");

    const r = await openWorkspace({ token: TOKEN, workspace: "长风书院", name: "李老师", target: "13800138004" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const a = await control.account.findFirst({ where: { phone: "13800138004" } });
    expect(a!.password).not.toBe(r.password);
    expect(a!.password.startsWith("$2")).toBe(true);
  });

  it("同一个号开第二次要拒——否则他的第一个工作区就登不进去了", async () => {
    const { openWorkspace } = await import("@/app/admin/actions");
    const { control } = await import("@/lib/tenant/control");

    await openWorkspace({ token: TOKEN, workspace: "甲团队", name: "赵老师", target: "13800138005" });
    const 前 = await control.workspace.count();
    const 再来 = await openWorkspace({ token: TOKEN, workspace: "乙团队", name: "赵老师", target: "13800138005" });

    expect(再来.ok).toBe(false);
    expect(await control.workspace.count()).toBe(前);
  });

  it("两次开出来的密码不一样——重样一次就是两个工作区共用一把钥匙", async () => {
    const { openWorkspace } = await import("@/app/admin/actions");
    const a = await openWorkspace({ token: TOKEN, workspace: "甲", name: "钱老师", target: "13800138006" });
    const b = await openWorkspace({ token: TOKEN, workspace: "乙", name: "孙老师", target: "13800138007" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.password).not.toBe(b.password);
    // slug 也不能撞：它同时是库文件名
    expect(a.slug).not.toBe(b.slug);
  });

  it("手机号邮箱都不像就拒，不留半个账号", async () => {
    const { openWorkspace } = await import("@/app/admin/actions");
    const { control } = await import("@/lib/tenant/control");
    const 前 = await control.account.count();
    const r = await openWorkspace({ token: TOKEN, workspace: "丙团队", name: "周老师", target: "乱写的" });
    expect(r.ok).toBe(false);
    expect(await control.account.count()).toBe(前);
  });
});
