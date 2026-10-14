/** 2026-10-08 审计：真实 SQLite 恢复 + 真实同步客户端，传输层仅用合成中转。 */
import { it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const fixture = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-restore-audit-"));
  const db = path.join(dir, "crm.db");
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), db);
  return { dir, db };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: `file:${fixture.db}` }) };
});
import { prisma } from "@/lib/prisma";
import { 建同步表, 装触发器, 本机结构签名 } from "@/lib/sync/local";
import { 同步一轮, 设传输 } from "@/lib/sync/client";
import { 新钥匙, 封 } from "@/lib/sync/crypto";

const require_ = createRequire(import.meta.url);
const 自动 = require_("../desktop/auto-backup.js");
const 备份 = require_("../desktop/backup.js");

it("团队恢复旧备份后再次同步，必须补回同事的更新和删除", async () => {
  const 旧环境 = { DESKTOP_LOCAL: process.env.DESKTOP_LOCAL, CRM_DATA_DIR: process.env.CRM_DATA_DIR };
  const 拉取游标: number[] = [];
  try {
    process.env.DESKTOP_LOCAL = "1";
    process.env.CRM_DATA_DIR = fixture.dir;
    await prisma.user.create({ data: { id: "acct_auditowner", email: "audit-owner@example.invalid", name: "审计老板", password: "unused", role: "ADMIN" } });
    const 改的 = await prisma.customer.create({ data: { name: "审计客户更新", phone: "13000008001", salesOwnerId: "acct_auditowner", remark: "备份时旧备注" } });
    const 删的 = await prisma.customer.create({ data: { name: "审计客户删除", phone: "13000008002", salesOwnerId: "acct_auditowner" } });
    await 建同步表(prisma);
    await 装触发器(prisma);
    const key = 新钥匙();
    const teamId = "auditteamxxxxxxxx";
    fs.writeFileSync(path.join(fixture.dir, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: "auditowner", name: "审计老板", contact: "audit-owner@example.invalid", models: [] }));
    fs.writeFileSync(path.join(fixture.dir, ".team.json"), JSON.stringify({ teamId, teamName: "审计", device: "dLOCAL01", key, pulled: 0, 结构: await 本机结构签名(prisma) }));
    自动.自动备份({ 库: fixture.db, 数据目录: fixture.dir, 版本: "0.46.15", 现在: new Date("2026-10-04T09:00:00"), 日志: () => {} });
    const data = 封([
      { t: "Customer", k: 改的.id, o: "U", r: { id: 改的.id, remark: "同事备份后新备注" }, c: ["remark"], h: "999999999999990-dREMOTE1" },
      { t: "Customer", k: 删的.id, o: "D", r: {}, c: [], h: "999999999999991-dREMOTE1" },
    ], key, 0, { teamId, device: "dREMOTE1" });
    设传输(async (方法, 路径) => {
      if (路径 === "/api/sync/team") return { 状态: 200, json: { teams: [{ id: teamId, active: true, 成员: [{ accountId: "auditowner", role: "owner" }] }] } };
      if (方法 === "POST" && 路径 === "/api/sync/push") return { 状态: 200, json: { ok: true } };
      if (路径.startsWith("/api/sync/pull?")) {
        const after = Number(new URL(`http://fake${路径}`).searchParams.get("after"));
        拉取游标.push(after);
        return { 状态: 200, json: { batches: after < 1 ? [{ seq: 1, device: "dREMOTE1", data }] : [], more: false, epoch: 0 } };
      }
      return { 状态: 404, json: {} };
    });
    expect(await 同步一轮()).toMatchObject({ ok: true, 拉: 2 });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 改的.id } })).remark).toBe("同事备份后新备注");
    expect(await prisma.customer.findUnique({ where: { id: 删的.id } })).toBeNull();
    await prisma.$disconnect(); // 模拟壳先停本机服务，再恢复数据库
    自动.恢复({ 库: fixture.db, 数据目录: fixture.dir, 文件名: "daily-2026-10-04.db", 校验: 备份.校验数据库 });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 改的.id } })).remark).toBe("备份时旧备注");
    expect(await 同步一轮()).toMatchObject({ ok: true });
    expect.soft((await prisma.customer.findUniqueOrThrow({ where: { id: 改的.id } })).remark, `恢复后请求游标：${拉取游标.join(",")}`).toBe("同事备份后新备注");
    expect.soft(await prisma.customer.findUnique({ where: { id: 删的.id } }), "同事已删除的客户不能恢复后永久留在本机").toBeNull();
  } finally {
    设传输(null);
    for (const [k, v] of Object.entries(旧环境)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await prisma.$disconnect();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
