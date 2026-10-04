/**
 * 团队版「改完推一下」（lib/team-scope.ts 改完推一下）。
 * T-042（2026-10-04 上线前回归核对）前半：五人实测里写的那台要等自己下一轮才推、看的那台再等它下一轮才拉，平均十几秒，
 * 用户会以为没同步。现在本机在团队里、有人写了库，1.5 秒后（连着改只算一次）同步一轮；
 * 同步自己回放时写的不算（__同步中），不然收一轮又推一轮。这里用假计时器钉住这三条。
 * 同步一轮 换成假的（vi.mock），只看它被调了几次；写库用一条什么都改不到的 updateMany（照样算写操作）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const 假 = vi.hoisted(() => ({ 同步一轮: vi.fn(async () => ({ ok: true as const, 推: 0, 拉: 0, 撞: 0 })) }));
vi.mock("@/lib/sync/client", () => ({ 同步一轮: 假.同步一轮 }));

import { PrismaClient } from "@/generated/prisma";
import { 加上限定, 标同步中, 忘掉限定 } from "@/lib/team-scope";

const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-team-push-"));
const 原 = { dir: process.env.CRM_DATA_DIR, local: process.env.DESKTOP_LOCAL };
const raw = new PrismaClient();
const db = 加上限定(raw);
const 写一下 = () => db.customer.updateMany({ where: { id: "没有这一位" }, data: { remark: "x" } });
/** 让 setTimeout 回调里的动态 import 和 then 跑完 */
const 等一等 = async () => {
  await vi.dynamicImportSettled();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

beforeAll(() => {
  process.env.CRM_DATA_DIR = 目录;
  process.env.DESKTOP_LOCAL = "1";
  fs.writeFileSync(path.join(目录, ".team.json"), JSON.stringify({ teamId: "t1", key: "k", device: "d", pulled: 0 }));
});
afterAll(async () => {
  if (原.dir === undefined) delete process.env.CRM_DATA_DIR; else process.env.CRM_DATA_DIR = 原.dir;
  if (原.local === undefined) delete process.env.DESKTOP_LOCAL; else process.env.DESKTOP_LOCAL = 原.local;
  fs.rmSync(目录, { recursive: true, force: true });
  忘掉限定();
  await raw.$disconnect();
});
beforeEach(() => {
  假.同步一轮.mockClear();
  忘掉限定();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  标同步中(false);
  vi.useRealTimers();
});

describe("写库 1.5 秒后自动同步一轮（T-042）", () => {
  it("写一条：1.5 秒前不推，到 1.5 秒推一次", async () => {
    await 写一下();
    vi.advanceTimersByTime(1499);
    await 等一等();
    expect(假.同步一轮).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await 等一等();
    expect(假.同步一轮).toHaveBeenCalledTimes(1);
  });

  it("连着改几条：从最后一条算 1.5 秒，只推一次", async () => {
    await 写一下();
    vi.advanceTimersByTime(1000);
    await 写一下();
    vi.advanceTimersByTime(1000);
    await 等一等();
    expect(假.同步一轮).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    await 等一等();
    expect(假.同步一轮).toHaveBeenCalledTimes(1);
  });

  it("同步中（回放别人的改动）写的不触发", async () => {
    标同步中(true);
    await 写一下();
    vi.advanceTimersByTime(5000);
    await 等一等();
    expect(假.同步一轮).not.toHaveBeenCalled();
  });

  it("只读不触发；不在团队里写也不触发", async () => {
    await db.customer.count();
    vi.advanceTimersByTime(5000);
    await 等一等();
    expect(假.同步一轮).not.toHaveBeenCalled();
    fs.renameSync(path.join(目录, ".team.json"), path.join(目录, ".team.json.bak"));
    try {
      await 写一下();
      vi.advanceTimersByTime(5000);
      await 等一等();
      expect(假.同步一轮).not.toHaveBeenCalled();
    } finally {
      fs.renameSync(path.join(目录, ".team.json.bak"), path.join(目录, ".team.json"));
    }
  });
});
